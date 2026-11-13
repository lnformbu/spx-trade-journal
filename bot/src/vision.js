// Reads a chart screenshot with Cloudflare's built-in vision model (free daily allowance).
// Returns structured notes: what's on the chart, not a trading decision.
const MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

const PROMPT = `You are reading a trading chart screenshot (usually thinkorswim, dark theme, SPX/SPY options day trading).
Report only what is visible. Reply with ONE JSON object, no other text:
{
 "ticker": "e.g. SPX, SPY, TSLA or null",
 "timeframe": "e.g. 1m, 3m, 10m, 1h, D or null",
 "date_time": "date/time shown on the chart or null",
 "direction": "bull, bear or neutral (the idea the drawings/annotations suggest)",
 "setup": "short name of the setup if it is clear (e.g. bull flag, breakout, rejection at resistance, engulfing at support) or null",
 "candle_patterns": ["visible candlestick patterns near the right edge, e.g. bullish engulfing, pin bar, inside bar"],
 "levels": [{"label": "text next to the line or what it looks like", "price": 0}],
 "indicators": ["indicator names/values visible in headers or labels, e.g. Saty Phase Oscillator 57.31, Pivot Ribbon"],
 "annotations": "any text, arrows or circles the trader drew, and what they point at",
 "price_now": 0,
 "summary": "one or two sentences describing the chart"
}`;

// bytes -> base64 without blowing the stack
function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function firstJSON(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

// url: the Discord image (a resized proxy link when available, to keep it small)
export async function readChart(env, url) {
  if (!env.AI) throw new Error("AI binding missing");
  const r = await fetch(url);
  if (!r.ok) throw new Error("image download " + r.status);
  const type = r.headers.get("content-type") || "image/png";
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 3.5e6) throw new Error("image too large (" + Math.round(buf.byteLength / 1e6) + " MB)");
  const out = await env.AI.run(MODEL, {
    messages: [{ role: "user", content: [
      { type: "text", text: PROMPT },
      { type: "image_url", image_url: { url: `data:${type};base64,${b64(buf)}` } },
    ] }],
    max_tokens: 700,
  });
  const text = typeof out === "string" ? out : out.response ?? JSON.stringify(out);
  const json = typeof out.response === "object" ? out.response : firstJSON(text);
  return { model: MODEL, bytes: buf.byteLength, data: json, raw: json ? undefined : String(text).slice(0, 800) };
}

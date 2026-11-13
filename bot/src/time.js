import { et, hhmm } from "./levels.js";

// New York date + "HH:MM" -> timestamp (tries both EST and EDT)
export function etToMs(date, time = "09:30") {
  for (const off of [4, 5]) {
    const ms = Date.parse(`${date}T${time}:00Z`) + off * 3600e3;
    const x = et(ms);
    if (x.date === date && hhmm(x.min).padStart(5, "0") === time.padStart(5, "0")) return ms;
  }
  return Date.parse(`${date}T${time}:00Z`) + 5 * 3600e3;
}

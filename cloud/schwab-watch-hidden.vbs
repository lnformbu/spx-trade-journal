' Starts schwab-watch.cmd from this folder with no console window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "cmd /c """ & dir & "\schwab-watch.cmd""", 0, False

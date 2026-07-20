' launch-blackbox.vbs — open BLACKBOX instantly, windowless.
' Just launches the current build. NO rebuild on launch (that pegged the CPU
' and lagged the machine, 2026-07-20). New versions are compiled at build time,
' not on your double-click, so opening is instant.
Option Explicit
Dim sh, fso, scriptDir, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
' resolve the exe relative to this script's own folder — no hardcoded user path
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
exe = fso.BuildPath(scriptDir, "src-tauri\target\release\blackbox.exe")
If fso.FileExists(exe) Then
  sh.Run """" & exe & """", 1, False
Else
  sh.Popup "BLACKBOX isn't built yet. Run: cargo tauri build", 6, "BLACKBOX", 48
End If

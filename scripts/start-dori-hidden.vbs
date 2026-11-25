' 登录时静默拉起 dori（由 HKCU\...\Run 的 dori 值调用）
Dim sh, ps1, cmd
Set sh = CreateObject("WScript.Shell")
ps1 = "D:\github\poro-superagent\scripts\start-dori.ps1"
cmd = "pwsh.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """ -Quiet"
sh.Run cmd, 0, False

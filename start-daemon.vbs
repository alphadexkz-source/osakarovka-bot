Dim oShell, sCmd, sDir
sDir = "C:\projects\osakarovka-bot"
sCmd = "cmd /c cd /d " & sDir & " && npx -y ruflo@latest daemon start >> .claude-flow\logs\daemon.log 2>&1"
Set oShell = CreateObject("WScript.Shell")
' 1 = normal window, False = don't wait
oShell.Run sCmd, 0, False
Set oShell = Nothing

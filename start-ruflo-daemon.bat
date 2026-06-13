@echo off
:: Запускает Ruflo daemon отдельно от Claude Code
:: stdout/stderr идут в лог-файл — daemon не падает при закрытии Claude Code

set PROJECT_DIR=%~dp0
set LOG_FILE=%PROJECT_DIR%.claude-flow\logs\daemon.log
set PID_FILE=%PROJECT_DIR%.claude-flow\daemon.pid

:: Проверяем не запущен ли уже
if exist "%PID_FILE%" (
    set /p EXISTING_PID=<"%PID_FILE%"
    tasklist /FI "PID eq %EXISTING_PID%" 2>NUL | find /I "node.exe" >NUL 2>&1
    if not errorlevel 1 (
        echo [Ruflo Daemon] Already running (PID %EXISTING_PID%)
        exit /b 0
    )
    del "%PID_FILE%" >NUL 2>&1
)

echo [Ruflo Daemon] Starting...
cd /d "%PROJECT_DIR%"

:: Ключевое: stdout и stderr в файл, не в пайп Claude Code
:: Это предотвращает краш "write EOF" при закрытии Claude Code
start "ruflo-daemon" /MIN cmd /c "npx -y ruflo@latest daemon start 1>> .claude-flow\logs\daemon.log 2>&1"

timeout /t 3 /nobreak >nul
echo [Ruflo Daemon] Started. Log: %LOG_FILE%

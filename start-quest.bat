@echo off
title quest service
cd /d "%~dp0"
:loop
node server.mjs >> "%USERPROFILE%\.dsh\quests\quest-run.log" 2>&1
echo [%date% %time%] quest exited, code=%errorlevel%. restarting in 5s...
timeout /t 5 /nobreak >nul
goto loop

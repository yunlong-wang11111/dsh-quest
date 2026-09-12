@echo off
rem quest service supervisor
rem  1) restart the service 5s after it exits (crash self-heal)
rem  2) single-instance guard: if QUEST_PORT is already LISTENING, do NOT start a second copy
rem     (two instances fight over the port and spam the log)
rem  3) log rotation: archive to .1 once the log exceeds 32MB
rem Started by the scheduled task "quest-service" at logon and re-checked hourly;
rem you can also just double-click this file. Stop it by ending the "quest service" window.
rem QUEST_PORT / QUEST_LOG env vars override the defaults (used by sandbox tests).
setlocal
title quest service
cd /d "%~dp0"

set PORT=%QUEST_PORT%
if "%PORT%"=="" set PORT=3110
set LOG=%QUEST_LOG%
if "%LOG%"=="" set LOG=%USERPROFILE%\.dsh\quests\quest-run.log

:loop
rem -- single-instance guard: port already in use means quest is already running --
netstat -ano -p tcp | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 (
  ping -n 61 127.0.0.1 >nul
  goto loop
)

rem -- log rotation: archive to .1 above 32MB --
if exist "%LOG%" for %%F in ("%LOG%") do if %%~zF GTR 33554432 move /y "%LOG%" "%LOG%.1" >nul 2>&1

echo [%date% %time%] starting quest (port %PORT%) >> "%LOG%"
node server.mjs >> "%LOG%" 2>&1
echo [%date% %time%] quest exited, code=%errorlevel%. restarting in 5s... >> "%LOG%"
ping -n 6 127.0.0.1 >nul
goto loop

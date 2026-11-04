@echo off
set ELECTRON_RUN_AS_NODE=
if not exist "%~dp0PDF Cross Probe.exe" (
  echo PDF Cross Probe.exe is missing. Extract or copy the complete folder first.
  pause
  exit /b 1
)
start "" "%~dp0PDF Cross Probe.exe"
@echo off
rem KRA-6491: Windows entry. npm cmd-shims cannot run the POSIX sh launcher.
rem Runs Node.js from PATH; set TENTACLES_NODE to an absolute node.exe to pin it.
setlocal
if defined TENTACLES_NODE (set "_TENTACLES_NODE=%TENTACLES_NODE%") else (set "_TENTACLES_NODE=node")
"%_TENTACLES_NODE%" "%~dp0..\src\cli.mjs" %*

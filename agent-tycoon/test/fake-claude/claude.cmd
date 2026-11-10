@echo off
rem Fake claude for tests on Windows: the Node script beside it (claude, engine.cjs is linked by testHome).
node "%~dp0claude" %*

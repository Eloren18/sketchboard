@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
echo ==================================================
echo    Sketchboard: one-time secrets setup
echo ==================================================
echo.
echo This copies the Resend key (sign-in emails) from the Budget app's
echo Convex project, then optionally asks for a Claude API key for the
echo in-app chat. Nothing is shown on screen or stored in this folder.
echo.

set "BUDGET=%~dp0..\Claude Budget App"
set "RESEND="
if not exist "%BUDGET%\.env.local" goto :nobudget

echo Reading RESEND_API_KEY from the Budget app (may take a few seconds)...
for /f "usebackq delims=" %%K in (`cd /d "%BUDGET%" ^&^& call npx convex env get RESEND_API_KEY --prod 2^>nul`) do set "RESEND=%%K"
if not defined RESEND goto :nokey
if not "!RESEND:~0,3!"=="re_" goto :nokey

echo Setting it on the Sketchboard dev and prod deployments...
call npx convex env set RESEND_API_KEY !RESEND!
call npx convex env set --prod RESEND_API_KEY !RESEND!
set "RESEND="
echo   Resend key set.
goto :claude

:nobudget
echo Could not find the Budget app at "%BUDGET%".
goto :manual

:nokey
echo Could not read the key from the Budget app's Convex project.
goto :manual

:manual
echo Set it by hand instead (the key starts with re_ ; find it at resend.com -^> API Keys):
echo    npx convex env set RESEND_API_KEY re_xxx
echo    npx convex env set --prod RESEND_API_KEY re_xxx
echo.

:claude
echo.
echo Claude API key for the in-app chat (console.anthropic.com, starts with sk-ant-).
echo Press Enter to skip if you use Claude Code instead of the in-app chat.
set "ANTHKEY="
set /p "ANTHKEY=ANTHROPIC_API_KEY: "
if "!ANTHKEY!"=="" goto :done
call npx convex env set ANTHROPIC_API_KEY !ANTHKEY!
call npx convex env set --prod ANTHROPIC_API_KEY !ANTHKEY!
set "ANTHKEY="
echo   Claude key set.

:done
echo.
echo --------------------------------------------------
echo  Variables now on the live deployment:
call npx convex env list --prod
echo --------------------------------------------------
pause

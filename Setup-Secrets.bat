@echo off
cd /d "%~dp0"
echo ==================================================
echo    Sketchboard: one-time secrets setup
echo ==================================================
echo.
echo This copies the Resend key (sign-in emails) from the Budget app's
echo Convex project, and asks you for a Claude API key for the chat.
echo Nothing is shown on screen or stored in this folder.
echo.

set BUDGET=%~dp0..\Claude Budget App
if not exist "%BUDGET%\.env.local" (
  echo Could not find the Budget app at "%BUDGET%". Set RESEND_API_KEY by hand:
  echo    npx convex env set RESEND_API_KEY re_xxx
  echo    npx convex env set --prod RESEND_API_KEY re_xxx
) else (
  echo Copying RESEND_API_KEY from the Budget app...
  for /f "usebackq delims=" %%K in (`cd /d "%BUDGET%" ^&^& npx convex env get RESEND_API_KEY --prod`) do set RESEND=%%K
  if "%RESEND%"=="" (
    echo   Could not read it. Set it by hand with: npx convex env set RESEND_API_KEY re_xxx
  ) else (
    call npx convex env set RESEND_API_KEY %RESEND%
    call npx convex env set --prod RESEND_API_KEY %RESEND%
    echo   Resend key set on dev and prod.
  )
)
set RESEND=

echo.
echo Now the Claude API key for the chat assistant (from console.anthropic.com,
echo starts with sk-ant-). Leave empty to skip; the chat will say it is missing.
set /p ANTHKEY=ANTHROPIC_API_KEY:
if not "%ANTHKEY%"=="" (
  call npx convex env set ANTHROPIC_API_KEY %ANTHKEY%
  call npx convex env set --prod ANTHROPIC_API_KEY %ANTHKEY%
  echo   Claude key set on dev and prod.
)
set ANTHKEY=

echo.
echo --------------------------------------------------
echo  Done. Check with:  npx convex env list --prod
echo --------------------------------------------------
pause

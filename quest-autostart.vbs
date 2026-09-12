' quest service hidden launcher
' Used two ways (pick one, not both):
'   - scheduled task "quest-service": runs this at logon and re-checks hourly (recommended)
'   - a shortcut to this file in your Startup folder (simplest)
' It runs start-quest.bat from THIS folder, hidden, and WAITS for it (third arg = True).
' Waiting matters: while this wscript process is alive the scheduled task counts as "running",
' so its hourly re-check is skipped by MultipleInstancesPolicy=IgnoreNew -- otherwise every
' hour would pile up another supervisor loop. If the loop dies, this process exits, the task
' instance ends, and the next check starts a fresh one.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & here & "\start-quest.bat""", 0, True

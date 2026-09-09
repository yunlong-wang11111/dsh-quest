' quest service hidden launcher (put a shortcut to this file in the Startup folder)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run """" & dir & "\start-quest.bat""", 0, False

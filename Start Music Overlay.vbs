Option Explicit

Dim fso, shell, scriptDir, frontendDir, electronExe, distIndex, procEnv, cmd

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
frontendDir = fso.BuildPath(scriptDir, "frontend")
electronExe = fso.BuildPath(frontendDir, "node_modules\electron\dist\electron.exe")
distIndex = fso.BuildPath(frontendDir, "dist\index.html")

If Not fso.FileExists(electronExe) Then
  MsgBox "Electron binary not found:" & vbCrLf & electronExe & vbCrLf & vbCrLf & "Run 'npm install' inside frontend first.", vbExclamation, "Music Overlay"
  WScript.Quit 1
End If

If Not fso.FileExists(distIndex) Then
  MsgBox "Frontend build not found:" & vbCrLf & distIndex & vbCrLf & vbCrLf & "Run 'npm run build' inside frontend first.", vbExclamation, "Music Overlay"
  WScript.Quit 1
End If

Set procEnv = shell.Environment("PROCESS")
On Error Resume Next
procEnv.Remove "ELECTRON_RUN_AS_NODE"
On Error GoTo 0

shell.CurrentDirectory = frontendDir
cmd = """" & electronExe & """ """ & frontendDir & """"
shell.Run cmd, 0, False

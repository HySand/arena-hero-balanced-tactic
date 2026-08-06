Option Explicit

Dim shell, fso, root, pythonw, pythonFallback, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
pythonw = root & "\.venv\Scripts\pythonw.exe"
pythonFallback = ""

If Not fso.FileExists(pythonw) Then
    If fso.FileExists(root & "\launcher.pyw") Then
        pythonFallback = "pythonw.exe"
    End If
End If

If fso.FileExists(pythonw) Then
    command = Chr(34) & pythonw & Chr(34) & " " & Chr(34) & root & "\launcher.pyw" & Chr(34)
ElseIf pythonFallback <> "" Then
    command = pythonFallback & " " & Chr(34) & root & "\launcher.pyw" & Chr(34)
Else
    MsgBox "Python runtime not found. Install Python 3.11+ or run scripts\setup.cmd.", vbCritical, "Arena Hero"
    WScript.Quit 1
End If

shell.CurrentDirectory = root
shell.Run command, 0, False
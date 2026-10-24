Unicode true
Name "Foundry Client (Rust)"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\Foundry Client Rust"
RequestExecutionLevel user
SetCompressor /SOLID lzma
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Foundry Client (Rust)"
VIAddVersionKey "FileDescription" "Foundry Client native Rust installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Hierarchs"
!include "MUI2.nsh"
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\FoundryClient.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "Foundry Client"
  SetOutPath "$INSTDIR"
  File /oname=FoundryClient.exe "${APP_EXE}"
  File /oname=THIRD_PARTY_NOTICES.txt "${NOTICES_FILE}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Foundry Client Rust"
  CreateShortcut "$SMPROGRAMS\Foundry Client Rust\Foundry Client.lnk" "$INSTDIR\FoundryClient.exe"
  CreateShortcut "$DESKTOP\Foundry Client (Rust).lnk" "$INSTDIR\FoundryClient.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "DisplayName" "Foundry Client (Rust)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "Publisher" "Hierarchs"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "DisplayIcon" "$INSTDIR\FoundryClient.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\FoundryClient.exe"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\Foundry Client (Rust).lnk"
  Delete "$SMPROGRAMS\Foundry Client Rust\Foundry Client.lnk"
  RMDir "$SMPROGRAMS\Foundry Client Rust"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\FoundryClientRust"
SectionEnd

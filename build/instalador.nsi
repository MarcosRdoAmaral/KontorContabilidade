; Instalador do Kontor Gestão Contabilidade (Windows). Instalação por usuário: não pede senha de administrador.
Unicode true
!include "MUI2.nsh"

!ifndef VERSAO
  !define VERSAO "3.13.1"
!endif
!define NOME "Kontor Gestão Contabilidade"
!define EXE "Kontor Gestão Contabilidade.exe"
!define CHAVE "Software\Microsoft\Windows\CurrentVersion\Uninstall\KontorContabilidade"

Name "${NOME}"
OutFile "${SAIDA}"
InstallDir "$LOCALAPPDATA\Programs\Kontor Contabilidade"
InstallDirRegKey HKCU "Software\KontorContabilidade" "Pasta"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${NOME} ${VERSAO}"

VIProductVersion "${VERSAO}.0"
VIAddVersionKey /LANG=1046 "ProductName" "${NOME}"
VIAddVersionKey /LANG=1046 "FileDescription" "Instalador do ${NOME}"
VIAddVersionKey /LANG=1046 "FileVersion" "${VERSAO}"

!define MUI_ICON "${ICONE}"
!define MUI_UNICON "${ICONE}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir o ${NOME} agora"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section "Instalar"
  ; fecha o programa se estiver aberto (atualização)
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Pop $0
  Sleep 600

  ; atualização: limpa só os arquivos do programa da versão anterior (os dados ficam em %APPDATA%)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  SetOutPath "$INSTDIR"
  File /r "${ORIGEM}/*.*"
  WriteUninstaller "$INSTDIR\Desinstalar.exe"

  CreateShortcut "$DESKTOP\${NOME}.lnk" "$INSTDIR\${EXE}"
  CreateDirectory "$SMPROGRAMS\${NOME}"
  CreateShortcut "$SMPROGRAMS\${NOME}\${NOME}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$SMPROGRAMS\${NOME}\Desinstalar.lnk" "$INSTDIR\Desinstalar.exe"

  WriteRegStr HKCU "Software\KontorContabilidade" "Pasta" "$INSTDIR"
  WriteRegStr HKCU "${CHAVE}" "DisplayName" "${NOME}"
  WriteRegStr HKCU "${CHAVE}" "DisplayVersion" "${VERSAO}"
  WriteRegStr HKCU "${CHAVE}" "Publisher" "${NOME}"
  WriteRegStr HKCU "${CHAVE}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${CHAVE}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${CHAVE}" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKCU "${CHAVE}" "NoModify" 1
  WriteRegDWORD HKCU "${CHAVE}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM "${EXE}"'
  Pop $0
  Sleep 600
  Delete "$DESKTOP\${NOME}.lnk"
  RMDir /r "$SMPROGRAMS\${NOME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${CHAVE}"
  DeleteRegKey HKCU "Software\KontorContabilidade"
  ; Os dados (notas, cadastros, backups) ficam em %APPDATA%\Kontor Gestão Contabilidade e NÃO são apagados.
  MessageBox MB_OK|MB_ICONINFORMATION "${NOME} foi removido.$\r$\n$\r$\nSuas notas e cadastros continuam guardados em:$\r$\n$APPDATA\Kontor Gestão Contabilidade$\r$\n$\r$\nApague essa pasta somente se não precisar mais dos dados."
SectionEnd

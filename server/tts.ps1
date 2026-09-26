# TTS：pwsh 7 专用（System.Speech 10 才有 SetOutputToWaveFile）
# 用法: pwsh -NoProfile -ExecutionPolicy Bypass -File tts.ps1 <wav输出> <文本文件>
param([string]$Wav, [string]$TextFile)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -like 'Microsoft Xiaoxiao' -and $_.VoiceInfo.Name -notlike '*Online*' } | Select-Object -First 1
if ($voice) { $s.SelectVoice($voice.VoiceInfo.Name) }
$s.SetOutputToWaveFile($Wav)
$text = Get-Content -Raw -Encoding UTF8 $TextFile
$s.Speak($text)
exit 0
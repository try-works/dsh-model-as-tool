<#
  Synthesize the voz qualification utterances with Windows System.Speech.

  The qualification record's provenance is honest about this: these are
  SYSTEM-SYNTHESIZED recordings (a deterministic smoke corpus), NOT a real-speaker
  corpus. Every utterance records the exact voice used, so a transcript assertion
  can be judged against what was actually spoken.

  Usage:
    powershell -NoProfile -ExecutionPolicy Bypass -File synthesize-voz-utterances.ps1 -OutDir <dir>

  Writes:
    <OutDir>/german.wav   — "Das ist ein Test." with a German voice when one is
                            installed, otherwise with a substituted voice (recorded)
    <OutDir>/english.wav  — "The quick brown fox jumps over the lazy dog." (en-US)
    <OutDir>/voices.json  — { german: {voice, culture, substituted}, english: {...} }
#>
param(
  [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo })

  $germanVoice = $null
  foreach ($v in $voices) {
    if ($v.Culture.Name -like 'de*') { $germanVoice = $v; break }
  }

  $englishVoice = $null
  foreach ($v in $voices) {
    if ($v.Culture.Name -like 'en-*') { $englishVoice = $v; break }
  }
  if ($null -eq $englishVoice) { $englishVoice = $voices[0] }

  $germanInfo = @{
    voice = if ($null -eq $germanVoice) { $synth.Voice.Name } else { $germanVoice.Name }
    culture = if ($null -eq $germanVoice) { $synth.Voice.Culture.Name } else { $germanVoice.Culture.Name }
    substituted = ($null -eq $germanVoice)
    note = if ($null -eq $germanVoice) {
      'no German voice is installed; the German utterance was synthesized with the default voice, so its transcript assertion is recorded, not judged'
    } else { '' }
  }

  # English first (the STRICT assertion), then German.
  $synth.SelectVoice($englishVoice.Name)
  $synth.SetOutputToWaveFile((Join-Path $OutDir 'english.wav'))
  $synth.Speak('The quick brown fox jumps over the lazy dog.')
  $synth.SetOutputToNull()

  if ($null -ne $germanVoice) { $synth.SelectVoice($germanVoice.Name) }
  $synth.SetOutputToWaveFile((Join-Path $OutDir 'german.wav'))
  $synth.Speak('Das ist ein Test.')
  $synth.SetOutputToNull()

  $record = @{
    german = @{
      voice = $germanInfo.voice
      culture = $germanInfo.culture
      substituted = $germanInfo.substituted
      note = $germanInfo.note
      utterance = 'Das ist ein Test.'
    }
    english = @{
      voice = $englishVoice.Name
      culture = $englishVoice.Culture.Name
      substituted = $false
      note = ''
      utterance = 'The quick brown fox jumps over the lazy dog.'
    }
    engine = 'System.Speech (Windows SAPI)'
  }
  $record | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $OutDir 'voices.json') -Encoding UTF8
}
finally {
  $synth.Dispose()
}

param([Parameter(Mandatory=$true)][long]$WindowHandle, [Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DailyCfWindowIcon {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", EntryPoint="GetClassLongPtrW")]
  public static extern IntPtr GetClassLongPtr(IntPtr window, int index);
}
'@
$window = [IntPtr]::new($WindowHandle)
$iconHandle = [IntPtr]::Zero
$method = ''
foreach ($kind in @(1, 0, 2)) {
  $result = [UIntPtr]::Zero
  $success = [DailyCfWindowIcon]::SendMessageTimeout($window, 0x007F, [UIntPtr]::new([uint64]$kind), [IntPtr]::Zero, 2, 2000, [ref]$result)
  if ($success -ne [IntPtr]::Zero -and $result -ne [UIntPtr]::Zero) {
    $iconHandle = [IntPtr]::new([long]$result.ToUInt64())
    $method = "WM_GETICON($kind)"
    break
  }
}
if ($iconHandle -eq [IntPtr]::Zero) {
  foreach ($index in @(-14, -34)) {
    $iconHandle = [DailyCfWindowIcon]::GetClassLongPtr($window, $index)
    if ($iconHandle -ne [IntPtr]::Zero) { $method = "GetClassLongPtr($index)"; break }
  }
}
if ($iconHandle -eq [IntPtr]::Zero) { throw 'Window exposes no native icon handle.' }
$borrowed = [System.Drawing.Icon]::FromHandle($iconHandle)
$copy = $borrowed.Clone()
$bitmap = $copy.ToBitmap()
try {
  $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $fillCount = 0; $strokeCount = 0; $pinkCount = 0
  for ($y = 0; $y -lt $bitmap.Height; $y++) {
    for ($x = 0; $x -lt $bitmap.Width; $x++) {
      $pixel = $bitmap.GetPixel($x, $y)
      if ($pixel.A -lt 240) { continue }
      if ([Math]::Abs($pixel.R - 196) -le 3 -and [Math]::Abs($pixel.G - 227) -le 3 -and [Math]::Abs($pixel.B - 204) -le 3) { $fillCount++ }
      if ([Math]::Abs($pixel.R - 40) -le 5 -and [Math]::Abs($pixel.G - 121) -le 5 -and [Math]::Abs($pixel.B - 80) -le 5) { $strokeCount++ }
      if ($pixel.R -gt $pixel.G + 12 -and $pixel.B -gt $pixel.G + 5) { $pinkCount++ }
    }
  }
  [PSCustomObject]@{ passed=($fillCount -gt 10 -and $strokeCount -gt 1 -and $pinkCount -eq 0); method=$method;
    width=$bitmap.Width; height=$bitmap.Height; expectedFill='#c4e3cc'; expectedStroke='#287950';
    fillPixels=$fillCount; strokePixels=$strokeCount; pinkPixels=$pinkCount; borrowedWindowHandle=$true } | ConvertTo-Json -Compress
} finally { $bitmap.Dispose(); $copy.Dispose() }

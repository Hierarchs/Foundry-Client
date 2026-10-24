$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap 256, 256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(16, 21, 30))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(217, 183, 119)), 5
$points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(128, 24), [System.Drawing.PointF]::new(218, 76), [System.Drawing.PointF]::new(218, 180), [System.Drawing.PointF]::new(128, 232), [System.Drawing.PointF]::new(38, 180), [System.Drawing.PointF]::new(38, 76))
$graphics.DrawPolygon($pen, $points)
$lines = @(@(128,24,78,100), @(128,24,178,100), @(78,100,128,190), @(178,100,128,190), @(78,100,178,100), @(38,76,78,100), @(218,76,178,100), @(38,180,78,100), @(218,180,178,100), @(38,180,128,190), @(218,180,128,190), @(128,190,128,232))
$pen.Width = 3
foreach ($line in $lines) { $graphics.DrawLine($pen, $line[0], $line[1], $line[2], $line[3]) }
$stream = [System.IO.MemoryStream]::new()
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $stream.ToArray()
$iconPath = Join-Path $PSScriptRoot '../src/ui/icon.ico'
$file = [System.IO.File]::Create($iconPath)
$writer = [System.IO.BinaryWriter]::new($file)
$writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$png.Length); $writer.Write([UInt32]22)
$writer.Write($png)
$writer.Dispose(); $file.Dispose(); $stream.Dispose(); $graphics.Dispose(); $pen.Dispose(); $bitmap.Dispose()
Write-Output "Created $iconPath"

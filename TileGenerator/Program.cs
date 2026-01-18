using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

const int tileSize = 256;
string[] mapFiles = new string[] { "gondwa.png" };

foreach (var mapFile in mapFiles)
{
    using var fullMap = new Bitmap(mapFile);

    // Build mip/pyramid levels: levels[0] = original (highest res), last = smallest (<= tileSize)
    var levels = new List<Bitmap>();
    levels.Add(new Bitmap(fullMap));

    while (levels[^1].Width > tileSize || levels[^1].Height > tileSize)
    {
        var prev = levels[^1];
        int nextW = Math.Max(1, prev.Width / 2);
        int nextH = Math.Max(1, prev.Height / 2);
        var down = new Bitmap(nextW, nextH, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(down);
        g.CompositingQuality = CompositingQuality.HighQuality;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.SmoothingMode = SmoothingMode.HighQuality;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.DrawImage(prev, 0, 0, nextW, nextH);
        levels.Add(down);
    }

    // Save tiles for each zoom level. Define zoom 0 as the smallest image (fits in single tile)
    int zoomCount = levels.Count;
    string mapName = Path.GetFileNameWithoutExtension(mapFile);

    for (int levelIndex = zoomCount - 1, z = 0; levelIndex >= 0; levelIndex--, z++)
    {
        var lvl = levels[levelIndex];
        SaveTiles(lvl, z, tileSize, mapName);
    }

    // Dispose all created bitmaps
    foreach (var b in levels)
        b.Dispose();
}

static void SaveTiles(Bitmap img, int zoom, int tileSize, string mapName)
{
    string outDir = Path.Combine("tiles", mapName, zoom.ToString());
    Directory.CreateDirectory(outDir);

    int tilesX = (img.Width + tileSize - 1) / tileSize;
    int tilesY = (img.Height + tileSize - 1) / tileSize;

    for (int ty = 0; ty < tilesY; ty++)
    {
        for (int tx = 0; tx < tilesX; tx++)
        {
            int sx = tx * tileSize;
            int sy = ty * tileSize;
            int w = Math.Min(tileSize, img.Width - sx);
            int h = Math.Min(tileSize, img.Height - sy);

            using var tile = new Bitmap(tileSize, tileSize, PixelFormat.Format32bppArgb);
            using var g = Graphics.FromImage(tile);
            // Fill background with the image edge color to avoid transparent regions turning black in JPEG/other
            Color fillColor = Color.Transparent;
            if (w > 0 && h > 0)
            {
                int sampleX = Math.Min(img.Width - 1, sx + Math.Max(0, w - 1));
                int sampleY = Math.Min(img.Height - 1, sy + Math.Max(0, h - 1));
                try
                {
                    fillColor = img.GetPixel(sampleX, sampleY);
                }
                catch
                {
                    fillColor = Color.White;
                }
            }
            if (fillColor == Color.Transparent)
                fillColor = Color.White;
            g.Clear(fillColor);
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.CompositingQuality = CompositingQuality.HighQuality;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            // Draw the portion of the source image into the top-left corner of the tile
            g.DrawImage(img, new Rectangle(0, 0, w, h), new Rectangle(sx, sy, w, h), GraphicsUnit.Pixel);

            // Save as PNG to preserve exact pixels and avoid compression artifacts at tile edges
            string filePath = Path.Combine(outDir, $"{tx}_{ty}.jpg");
            tile.Save(filePath, ImageFormat.Jpeg);
        }
    }
}

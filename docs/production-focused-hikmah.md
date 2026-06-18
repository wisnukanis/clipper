# Focused Hikmah Production Mode

Jalankan dry-run tanpa upload:

```bash
python main.py --mode dry-run --slot all
```

Render test satu slot:

```bash
python main.py --mode render-test --slot pagi
```

Upload pending tanpa benar-benar publish:

```bash
python main.py --mode upload-pending --dry-run
```

Mode ini memfokuskan channel ke `inspiratif_hikmah` dan `podcast_lucu_hikmah`, memakai discovery berbasis `yt-dlp`/cache, membatasi YouTube upload 3 video per hari, dan memasukkan video gagal quota ke `data/pending_uploads.json`.

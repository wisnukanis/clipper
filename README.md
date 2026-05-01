# Podcast Clipper Automation System

README ini menjelaskan rancangan sistem otomasi konten podcast berbasis **link video YouTube**. Sistem ini dirancang untuk berjalan otomatis setiap hari, mengambil link video yang sudah dimasukkan melalui dashboard, memprosesnya menjadi clip pendek 9:16, membuat caption dan thumbnail dengan AI, menyimpan output ke FTP hosting, lalu mempublikasikannya ke Instagram.

> Catatan keamanan: jangan menyimpan `.env`, API key, token, password FTP, cookies YouTube, atau credential lain di repository. Gunakan `.env` lokal untuk development dan secrets untuk deployment.

---

## 1. Konsep Utama

Sumber utama sistem adalah **link video YouTube**, bukan nama channel.

Artinya, user menyiapkan daftar link video untuk satu minggu melalui dashboard.

Contoh input mingguan:

```txt
Senin  : https://www.youtube.com/watch?v=VIDEO_ID_1
Selasa : https://www.youtube.com/watch?v=VIDEO_ID_2
Rabu   : https://www.youtube.com/watch?v=VIDEO_ID_3
Kamis  : https://www.youtube.com/watch?v=VIDEO_ID_4
Jumat  : https://www.youtube.com/watch?v=VIDEO_ID_5
Sabtu  : https://www.youtube.com/watch?v=VIDEO_ID_6
Minggu : https://www.youtube.com/watch?v=VIDEO_ID_7
```

Channel, playlist, atau auto-search tetap bisa menjadi fitur tambahan, tetapi **bukan prioritas utama untuk MVP**.

Prioritas input konten:

```txt
1. Link video YouTube manual dari dashboard
2. Playlist YouTube jika mode playlist diaktifkan
3. Channel YouTube jika mode channel diaktifkan
4. Auto-search jika fallback diaktifkan
```

---

## 2. Tujuan Sistem

Tujuan sistem adalah membuat mesin produksi konten harian:

```txt
Tema / Niche
→ Daftar link video YouTube
→ Pilih link video yang belum diproses
→ Kirim link ke sistem clipper
→ Proses transkrip, highlight, subtitle, crop, dan render video
→ Ambil output MP4 + metadata
→ Buat caption AI
→ Buat thumbnail
→ Upload video, thumbnail, metadata ke FTP hosting
→ Publish otomatis ke Instagram
→ Simpan riwayat
→ Cleanup file
```

Contoh niche:

```txt
podcast
podcast artis
podcast bisnis
podcast motivasi
podcast inspiratif
wawancara tokoh
cerita karier artis
konten edukasi bisnis
```

---

## 3. Strategi Implementasi Bertahap

Sistem **wajib dikerjakan dan diuji secara lokal terlebih dahulu** sebelum dideploy ke GitHub dan dijalankan lewat cron.

Hal ini penting karena pipeline clipper melibatkan banyak komponen:

```txt
yt-dlp
FFmpeg
Python
Deepgram
Gemini
faster-whisper
OpenCV
MediaPipe
cookies YouTube
dashboard
output video
FTP hosting
Instagram Graph API
```

Jika langsung dideploy ke GitHub, error bisa bercampur antara dependency, cookies, API, folder output, FTP, Instagram, atau cron. Karena itu urutannya harus bertahap.

---

### Phase 1 — Localhost Validation

Tujuan fase ini adalah memastikan seluruh pipeline berjalan di komputer lokal.

Yang harus berhasil di lokal:

```txt
1. Dashboard bisa dibuka.
2. Link video YouTube bisa diinput melalui dashboard.
3. Sistem bisa membaca link dari dashboard.
4. Sistem bisa mengirim link ke clipper.
5. Clipper bisa mengambil transcript/subtitle.
6. Jika transcript tidak tersedia, fallback transkripsi berjalan.
7. FFmpeg berhasil membuat video 9:16.
8. Output MP4 terbentuk di folder output.
9. Metadata JSON terbentuk.
10. Transcript/log tersedia.
11. Caption AI berhasil dibuat dari transcript.
12. Thumbnail berhasil dibuat dari frame video dan text overlay.
13. File output bisa di-upload ke FTP.
14. Public URL hasil FTP bisa dibuka dari browser.
```

Jika semua poin ini berhasil, sistem baru boleh dilanjutkan ke tahap deployment.

---

### Phase 2 — Localhost End-to-End Test

Pada fase ini, sistem dites dari awal sampai akhir secara lokal.

Alur yang harus berhasil:

```txt
input link YouTube
→ proses clipper
→ output video
→ generate caption
→ generate thumbnail
→ upload FTP
→ validasi public URL
```

Publish Instagram sebaiknya dites dalam mode aman terlebih dahulu:

```env
DRY_RUN=true
```

Jika sudah stabil, ubah menjadi:

```env
DRY_RUN=false
AUTO_PUBLISH=true
```

---

### Phase 3 — Deployment ke GitHub

Setelah local end-to-end berhasil, sistem baru dipindahkan ke GitHub.

Di GitHub, sistem harus dites manual terlebih dahulu menggunakan manual trigger.

Yang harus dipastikan:

```txt
1. Dependency Node.js berhasil di-install.
2. Dependency Python berhasil di-install.
3. FFmpeg tersedia.
4. yt-dlp tersedia.
5. Cookies tersedia jika dibutuhkan.
6. Environment variable terbaca dari secrets.
7. Output video berhasil dibuat.
8. Upload FTP berhasil.
9. Public URL valid.
10. Publish Instagram berhasil.
```

---

### Phase 4 — Cron GitHub

Setelah manual trigger di GitHub berhasil, baru aktifkan cron.

Catatan penting:

```txt
Cron dapat delay beberapa menit.
Sistem tidak boleh bergantung pada jam yang terlalu presisi.
Sistem harus mengecek apakah posting untuk tanggal hari ini sudah dilakukan.
```

Aturan cron harian:

```txt
Jika belum ada posting hari ini, lanjut proses.
Jika sudah ada posting hari ini, skip agar tidak duplikat.
```

---

### Phase 5 — Production Stabilization

Setelah cron berjalan, sistem masuk fase stabilisasi.

Yang harus dipantau:

```txt
1. Apakah cron berjalan setiap hari.
2. Apakah output video terbentuk.
3. Apakah FTP tidak penuh.
4. Apakah token Instagram masih valid.
5. Apakah cookies YouTube masih valid.
6. Apakah API key masih memiliki kuota.
7. Apakah history anti-duplikasi berjalan.
8. Apakah file besar berhasil dibersihkan setelah publish.
```

---

## 4. Prinsip Sistem

### 4.1 Job-based

Setiap proses harus memiliki `job_id`.

Contoh:

```txt
JOB-20260501-0500-PODCASTARTIS-001
```

Setiap job menyimpan:

```txt
job_id
theme
source_type
source_url
youtube_video_id
source_title
clipper_status
caption_status
thumbnail_status
publish_status
final_video_path
transcript_path
metadata_path
thumbnail_path
instagram_media_id
created_at
published_at
error_message
```

Sistem tidak boleh hanya bergantung pada “file terbaru” karena rawan salah ambil file. Jika harus mengambil file terbaru, tetap perlu divalidasi dengan waktu proses dan metadata job.

---

### 4.2 Anti-duplikasi

Sistem tidak boleh memproses atau memposting video yang sama dua kali.

Identitas unik:

```txt
youtube_video_id
source_url
job_id
final_video_hash
instagram_media_id
```

Jika video sudah pernah diproses atau dipublish, statusnya:

```txt
skipped_duplicate
```

---

### 4.3 Tahan Delay

Jika target jalan jam 05:00 WIB tetapi real berjalan jam 05:12 WIB, sistem tetap harus lanjut selama belum ada posting untuk tanggal tersebut.

Sistem tidak boleh bergantung pada menit yang terlalu presisi.

---

### 4.4 State Harus Persisten

Karena runner atau proses automation bisa bersifat sementara, semua data penting harus disimpan di media persisten.

Media penyimpanan utama:

```txt
FTP / shared hosting
```

FTP digunakan untuk:

```txt
menyimpan output video
menyimpan thumbnail
menyimpan metadata JSON
menyimpan log ringan
menyimpan history posting
menyediakan public URL untuk Instagram Graph API
```

---

## 5. Arsitektur Besar

```txt
Scheduler Harian
        ↓
Theme Manager
        ↓
Video Link Queue Manager
        ↓
Video Selector
        ↓
Clipper Runner
        ↓
Output Collector
        ↓
Caption Generator
        ↓
Thumbnail Generator
        ↓
FTP Uploader
        ↓
Instagram Publisher
        ↓
History Writer
        ↓
Cleanup Manager
```

---

## 6. Alur Harian

Setiap hari pada jam yang ditentukan:

```txt
1. Baca tema aktif dari dashboard.
2. Baca daftar link video YouTube yang aktif.
3. Pilih video berdasarkan target_date, priority, status, dan anti-duplikasi.
4. Buat job_id.
5. Kirim URL video ke sistem clipper.
6. Tunggu clipper selesai.
7. Ambil output MP4, metadata JSON, transkrip, subtitle, dan log.
8. Buat caption berdasarkan transkrip.
9. Buat teks thumbnail berdasarkan hook utama.
10. Buat thumbnail dari frame video atau visual AI.
11. Upload video, thumbnail, dan metadata ke FTP hosting.
12. Validasi public URL.
13. Publish ke Instagram.
14. Simpan history publish.
15. Cleanup file lokal atau sementara.
16. Update dashboard status.
```

---

## 7. Dashboard CRUD

Dashboard adalah pusat kontrol sistem.

---

### 7.1 CRUD Theme / Niche

Fungsi:

```txt
tambah tema
ubah tema
aktifkan tema
nonaktifkan tema
atur gaya caption
atur jumlah posting per hari
```

Contoh data:

```json
{
  "id": "theme_podcast_artis",
  "name": "podcast artis",
  "status": "active",
  "language": "id",
  "caption_style": "natural, emotional, hook-driven",
  "post_per_day": 1
}
```

---

### 7.2 CRUD YouTube Video Links

Ini adalah input utama.

Fungsi:

```txt
tambah link video YouTube
ubah tema video
tentukan tanggal target publish
ubah prioritas
aktifkan / nonaktifkan link
tandai skip
retry link gagal
lihat status proses sampai publish
```

Contoh data:

```json
{
  "id": "video_001",
  "source_type": "youtube_video",
  "url": "https://www.youtube.com/watch?v=xxxx",
  "youtube_video_id": "xxxx",
  "theme": "podcast artis",
  "priority": 1,
  "target_date": "2026-05-01",
  "active": true,
  "status": "queued",
  "notes": "Video utama untuk Senin"
}
```

Status:

```txt
queued
selected
submitted_to_clipper
clipper_processing
clipper_done
caption_done
thumbnail_done
ready_to_publish
published
failed
skipped_duplicate
skipped_manual
```

---

### 7.3 CRUD Optional Sources

Ini hanya fitur tambahan.

Bisa berupa:

```txt
channel YouTube
playlist YouTube
keyword pencarian
auto-search query
```

Contoh data:

```json
{
  "id": "src_optional_001",
  "type": "channel",
  "name": "Nama Channel Podcast",
  "url": "https://www.youtube.com/@contohchannel",
  "theme": "podcast artis",
  "priority": 1,
  "active": false,
  "notes": "Opsional, bukan input utama MVP"
}
```

Aturan:

```txt
Link video manual tetap prioritas utama.
Channel, playlist, dan auto-search hanya dipakai jika mode tersebut diaktifkan.
```

---

### 7.4 CRUD Queue / Job Monitor

Fungsi:

```txt
lihat video antrean
lihat video sedang diproses
lihat hasil clipper
lihat error
retry job gagal
batalkan job
arsipkan job
```

Contoh data:

```json
{
  "job_id": "JOB-20260501-0500-001",
  "video_id": "video_001",
  "source_url": "https://www.youtube.com/watch?v=xxxx",
  "theme": "podcast artis",
  "status": "clipper_processing",
  "created_at": "2026-05-01T05:00:00+07:00"
}
```

---

### 7.5 CRUD Prompt Template

Fungsi:

```txt
atur prompt caption
atur prompt thumbnail text
atur gaya bahasa per niche
atur hashtag
atur CTA
```

Contoh data:

```json
{
  "id": "caption_podcast_artis",
  "theme": "podcast artis",
  "hook_style": "emotional curiosity",
  "language": "id",
  "cta": "Menurut kamu, bagian paling relate yang mana?",
  "hashtag_template": "#PodcastIndonesia #PodcastArtis #ReelsIndonesia"
}
```

---

## 8. Strategi Pemilihan Video

Karena input utama adalah link video, sistem memilih video dengan urutan:

```txt
1. Ambil link dengan target_date hari ini.
2. Jika tidak ada, ambil queued video dengan prioritas tertinggi.
3. Jika ada beberapa video, pilih yang paling lama masuk queue.
4. Validasi youtube_video_id belum pernah diproses.
5. Buat job_id.
6. Kirim ke clipper.
```

---

## 9. Sistem Cookies YouTube

Beberapa video YouTube bisa gagal diakses karena bot-check, age gate, login requirement, atau pembatasan region. Sistem perlu mendukung cookies.

---

### 9.1 Mode Tanpa Cookies

Coba ambil subtitle/video secara normal terlebih dahulu.

---

### 9.2 Mode Cookies File

Jika gagal karena bot-check atau login, gunakan:

```env
YTDLP_COOKIES_FILE=cookies.txt
```

File `cookies.txt` tidak boleh di-commit ke repository.

---

### 9.3 Mode Local Browser Cookies

Untuk penggunaan lokal:

```env
YTDLP_COOKIES_FROM_BROWSER=chrome
```

atau:

```env
YTDLP_COOKIES_FROM_BROWSER=edge
```

atau:

```env
YTDLP_COOKIES_FROM_BROWSER=firefox
```

Mode ini cocok untuk laptop/PC lokal yang sudah login ke YouTube.

---

### 9.4 Cookies Lokal untuk Deployment

Cookies dari browser lokal bisa dipakai untuk deployment, tetapi harus dipindahkan secara aman.

Strategi:

```txt
export cookies dari browser lokal
simpan sebagai cookies.txt
jangan commit ke GitHub
simpan isi cookies di secret storage
saat workflow berjalan, generate cookies.txt dari secret
yt-dlp memakai cookies.txt
```

Risiko:

```txt
cookies adalah credential sensitif
cookies bisa expired
akun bisa diminta verifikasi ulang
akses dari environment berbeda bisa dianggap mencurigakan
```

Aturan aman:

```txt
jangan commit cookies.txt
jangan print cookies di log
gunakan akun operasional khusus jika memungkinkan
rotate cookies berkala
pakai cookies hanya untuk konten yang boleh diproses
```

---

## 10. FTP Hosting sebagai Media Penyimpanan

FTP hosting adalah storage persisten utama.

Contoh struktur:

```txt
/public_html/ig-generated/
├── videos/
│   └── JOB-20260501-0500-001.mp4
├── thumbnails/
│   └── JOB-20260501-0500-001.jpg
├── metadata/
│   └── JOB-20260501-0500-001.json
├── logs/
│   └── JOB-20260501-0500-001.log
└── history/
    └── published-posts.json
```

Public URL:

```txt
https://www.domain.com/ig-generated/videos/JOB-20260501-0500-001.mp4
https://www.domain.com/ig-generated/thumbnails/JOB-20260501-0500-001.jpg
https://www.domain.com/ig-generated/metadata/JOB-20260501-0500-001.json
```

Sistem tidak boleh publish jika public URL tidak bisa diakses.

---

## 11. Environment Instagram Automation

Contoh `.env.example`:

```env
LOCAL_PORT=8787
PUBLIC_BASE_URL=https://www.example.com/ig-generated
UPLOAD_DRIVER=ftp
AI_PROVIDER=gemini

GEMINI_API_KEY=
GEMINI_API_KEY_2=
GEMINI_API_KEY_3=
GEMINI_API_KEYS=
GEMINI_MODEL=gemini-flash-latest
GEMINI_TEMPERATURE=0.85

FTP_HOST=
FTP_PORT=21
FTP_USER=
FTP_PASSWORD=
FTP_REMOTE_DIR=/public_html/ig-generated

DEPLOY_REMOTE_DIR=/public_html
DEPLOY_CLEAN_REMOTE=false

DRY_RUN=false
AUTO_PUBLISH=true
CLEANUP_LOCAL_IMAGES_AFTER_PUBLISH=true
CLEANUP_LOCAL_IMAGES_AFTER_FTP_UPLOAD=true

AUTO_DASHBOARD_PIN=
AUTO_DASHBOARD_ALLOW_REMOTE=false

POST_CRON=0 8,13,19 * * *
DEFAULT_THEME=auto

GRAPH_API_VERSION=v25.0
INSTAGRAM_IG_USER_ID=
INSTAGRAM_ACCESS_TOKEN=

META_APP_ID=
META_APP_SECRET=
AUTO_REFRESH_INSTAGRAM_TOKEN=true
TOKEN_REFRESH_BEFORE_DAYS=10
```

### Fungsi Environment Instagram Automation

#### `LOCAL_PORT`

Port server lokal.

#### `PUBLIC_BASE_URL`

Base URL publik untuk file yang sudah di-upload ke hosting.

#### `UPLOAD_DRIVER`

Metode upload media. Untuk deployment gunakan:

```txt
ftp
```

#### `AI_PROVIDER`

Provider AI untuk caption, hook, dan teks pendukung.

#### `GEMINI_API_KEY`

API key utama Gemini.

#### `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`

Key cadangan jika key utama limit atau error.

#### `GEMINI_API_KEYS`

Daftar banyak key dalam satu variabel.

#### `GEMINI_MODEL`

Model Gemini yang digunakan.

#### `GEMINI_TEMPERATURE`

Mengatur kreativitas AI.

#### `FTP_HOST`

Host FTP.

#### `FTP_PORT`

Port FTP, umumnya `21`.

#### `FTP_USER`

Username FTP.

#### `FTP_PASSWORD`

Password FTP.

#### `FTP_REMOTE_DIR`

Folder remote tujuan upload.

#### `DEPLOY_REMOTE_DIR`

Folder remote untuk deploy dashboard/site jika ada.

#### `DEPLOY_CLEAN_REMOTE`

Jika `true`, folder remote dapat dibersihkan sebelum deploy.

#### `DRY_RUN`

Jika `true`, sistem generate tanpa publish.

#### `AUTO_PUBLISH`

Jika `true`, sistem boleh publish otomatis.

#### `CLEANUP_LOCAL_IMAGES_AFTER_PUBLISH`

Hapus file lokal setelah publish berhasil.

#### `CLEANUP_LOCAL_IMAGES_AFTER_FTP_UPLOAD`

Hapus file lokal setelah upload FTP berhasil.

#### `AUTO_DASHBOARD_PIN`

PIN dashboard internal.

#### `AUTO_DASHBOARD_ALLOW_REMOTE`

Jika `true`, dashboard bisa diakses remote. Default sebaiknya `false`.

#### `POST_CRON`

Jadwal lokal jika memakai scheduler internal.

#### `DEFAULT_THEME`

Tema default.

#### `GRAPH_API_VERSION`

Versi Instagram Graph API.

#### `INSTAGRAM_IG_USER_ID`

ID Instagram Business/Creator account.

#### `INSTAGRAM_ACCESS_TOKEN`

Token akses Instagram Graph API.

#### `META_APP_ID`

App ID Meta Developer.

#### `META_APP_SECRET`

App Secret Meta Developer.

#### `AUTO_REFRESH_INSTAGRAM_TOKEN`

Mengaktifkan refresh token otomatis.

#### `TOKEN_REFRESH_BEFORE_DAYS`

Jumlah hari sebelum expired untuk mulai refresh token.

---

## 12. Environment Auto Video Clipper

Contoh `.env.example`:

```env
DEEPGRAM_ENABLED=1
DEEPGRAM_API_KEYS=
DEEPGRAM_MODEL=nova-3
DEEPGRAM_LANGUAGE=id
DEEPGRAM_TIMEOUT_SECONDS=900

GEMINI_API_KEYS=
GEMINI_MODEL=gemini-flash-latest

CLIP_COUNT=1
MIN_CLIP_SECONDS=40
MAX_CLIP_SECONDS=60

OUTPUT_WIDTH=1080
OUTPUT_HEIGHT=1920
VIDEO_LANGUAGE=id

DOWNLOAD_MAX_HEIGHT=720
DOWNLOAD_COMPRESS_CRF=30
FINAL_RENDER_CRF=27

YTDLP_COOKIES_FILE=cookies.txt
YTDLP_COOKIES_FROM_BROWSER=
YTDLP_JS_RUNTIMES=node
YTDLP_REMOTE_COMPONENTS=ejs:github

SUBTITLE_OFFSET_SECONDS=0
SUBTITLE_FONT_SIZE=48
SUBTITLE_MARGIN_V=240
TRANSCRIPT_REVIEW_ENABLED=1
TRANSCRIPT_REVIEW_BATCH_SIZE=80

SMART_CROP_ENABLED=1
SMART_CROP_MODE=auto
SMART_CROP_SAMPLE_SECONDS=0.35
SMART_CROP_SMOOTHING=0.30
SMART_CROP_MAX_SHIFT_PER_SECOND=0.12

ACTIVE_SPEAKER_MAX_FACES=4
ACTIVE_SPEAKER_SWITCH_SECONDS=1.4
ACTIVE_SPEAKER_MOUTH_WEIGHT=0.55
ACTIVE_SPEAKER_FACE_WEIGHT=0.32
ACTIVE_SPEAKER_CENTER_WEIGHT=0.01
ACTIVE_SPEAKER_STICKINESS_WEIGHT=0.10
ACTIVE_SPEAKER_MIN_MOUTH_SCORE_TO_SWITCH=0.06

ACTIVE_SPEAKER_NO_FACE_STRATEGY=visual_content
ACTIVE_SPEAKER_NO_FACE_CENTER_AFTER_SECONDS=15.0
ACTIVE_SPEAKER_VISUAL_FALLBACK_ENABLED=1
ACTIVE_SPEAKER_VISUAL_MIN_SCORE=0.010
ACTIVE_SPEAKER_VISUAL_HOLD_SECONDS=2.0

ACTIVE_SPEAKER_INITIAL_ANCHOR_ENABLED=1
ACTIVE_SPEAKER_INITIAL_SCAN_SECONDS=6.0
ACTIVE_SPEAKER_INITIAL_SAMPLE_SECONDS=0.5
ACTIVE_SPEAKER_INITIAL_VISUAL_MIN_SCORE=0.010

OFFLINE_TRANSCRIBE_MODEL=small
OFFLINE_TRANSCRIBE_DEVICE=cpu
OFFLINE_TRANSCRIBE_COMPUTE_TYPE=int8

HF_TOKEN=
HF_HUB_DISABLE_SYMLINKS_WARNING=1
```

### Fungsi Environment Auto Video Clipper

#### `DEEPGRAM_ENABLED`

Mengaktifkan Deepgram untuk transkripsi.

#### `DEEPGRAM_API_KEYS`

Daftar key Deepgram.

#### `DEEPGRAM_MODEL`

Model transkripsi.

#### `DEEPGRAM_LANGUAGE`

Bahasa transkripsi.

#### `DEEPGRAM_TIMEOUT_SECONDS`

Timeout transkripsi.

#### `GEMINI_API_KEYS`

Key Gemini untuk analisis transkrip dan pemilihan highlight.

#### `GEMINI_MODEL`

Model Gemini.

#### `CLIP_COUNT`

Jumlah clip dari satu video.

#### `MIN_CLIP_SECONDS`

Durasi minimum clip.

#### `MAX_CLIP_SECONDS`

Durasi maksimum clip.

#### `OUTPUT_WIDTH`

Lebar output video.

#### `OUTPUT_HEIGHT`

Tinggi output video.

#### `VIDEO_LANGUAGE`

Bahasa video.

#### `DOWNLOAD_MAX_HEIGHT`

Resolusi maksimal download.

#### `DOWNLOAD_COMPRESS_CRF`

CRF kompresi awal.

#### `FINAL_RENDER_CRF`

CRF render final.

#### `YTDLP_COOKIES_FILE`

File cookies untuk yt-dlp.

#### `YTDLP_COOKIES_FROM_BROWSER`

Ambil cookies dari browser lokal.

#### `YTDLP_JS_RUNTIMES`

Runtime JavaScript untuk yt-dlp.

#### `YTDLP_REMOTE_COMPONENTS`

Remote component yt-dlp.

#### `SUBTITLE_OFFSET_SECONDS`

Offset timing subtitle.

#### `SUBTITLE_FONT_SIZE`

Ukuran font subtitle.

#### `SUBTITLE_MARGIN_V`

Margin vertikal subtitle.

#### `TRANSCRIPT_REVIEW_ENABLED`

Mengaktifkan review transkrip.

#### `TRANSCRIPT_REVIEW_BATCH_SIZE`

Ukuran batch review transkrip.

#### `SMART_CROP_ENABLED`

Mengaktifkan smart crop.

#### `SMART_CROP_MODE`

Mode crop: `auto`, `active_speaker`, `face`, `center`, atau `off`.

#### `SMART_CROP_SAMPLE_SECONDS`

Interval sampling crop.

#### `SMART_CROP_SMOOTHING`

Penghalus gerakan crop.

#### `SMART_CROP_MAX_SHIFT_PER_SECOND`

Batas gerakan crop per detik.

#### `ACTIVE_SPEAKER_*`

Konfigurasi active speaker untuk mendeteksi wajah/orang yang sedang bicara.

#### `OFFLINE_TRANSCRIBE_MODEL`

Model fallback faster-whisper.

#### `OFFLINE_TRANSCRIBE_DEVICE`

Device fallback: `cpu` atau `cuda`.

#### `OFFLINE_TRANSCRIBE_COMPUTE_TYPE`

Tipe komputasi fallback.

#### `HF_TOKEN`

Token Hugging Face untuk download model jika dibutuhkan.

#### `HF_HUB_DISABLE_SYMLINKS_WARNING`

Menghilangkan warning symlink Hugging Face.

---

## 13. Output Clipper yang Diharapkan

```txt
output/
├── JOB-20260501-0500-001.mp4
├── JOB-20260501-0500-001.json
├── JOB-20260501-0500-001.txt
├── JOB-20260501-0500-001.ass
└── JOB-20260501-0500-001-thumbnail.jpg
```

Metadata minimal:

```json
{
  "job_id": "JOB-20260501-0500-001",
  "source_type": "youtube_video",
  "source_url": "https://www.youtube.com/watch?v=xxxx",
  "youtube_video_id": "xxxx",
  "source_title": "Judul Video",
  "theme": "podcast artis",
  "status": "done",
  "finalPath": "output/JOB-20260501-0500-001.mp4",
  "transcriptPath": "output/JOB-20260501-0500-001.txt",
  "subtitlePath": "output/JOB-20260501-0500-001.ass",
  "thumbnailPath": "output/JOB-20260501-0500-001-thumbnail.jpg",
  "startTime": "00:04:12",
  "endTime": "00:05:07",
  "duration": 55,
  "createdAt": "2026-05-01T05:20:00+07:00"
}
```

---

## 14. Caption Rules

Caption dibuat dari transkrip atau log clipper.

Aturan:

```txt
Bahasa Indonesia
hook kuat di awal
jelaskan isi clip singkat
tidak mengarang fakta
tidak clickbait menyesatkan
CTA ringan
hashtag relevan
```

---

## 15. Thumbnail Rules

Default MVP:

```txt
frame asli video + text overlay
```

Aturan teks:

```txt
3 sampai 7 kata
mudah dibaca di HP
tidak menutup wajah/subjek utama
kontras tinggi
tidak menyesatkan isi video
```

Contoh:

```txt
DIA HAMPIR MENYERAH
CERITA YANG JARANG DIBUKA
TERNYATA INI ALASANNYA
INI YANG BIKIN BERTAHAN
```

---

## 16. Publish Rules

Publish hanya boleh dilakukan jika:

```txt
video final ada
video final valid
caption tidak kosong
metadata lengkap
belum pernah dipublish
FTP upload sukses
public URL bisa diakses
Instagram token valid
```

Jika publish gagal:

```txt
jangan hapus file
simpan error
tandai failed_publish
sediakan retry
```

---

## 17. Cleanup Rules

Cleanup hanya setelah publish sukses.

Yang boleh dihapus:

```txt
file sementara
audio sementara
video download mentah
cache render
```

Yang jangan dihapus:

```txt
metadata JSON
history publish
caption final
error log penting
instagram media ID
```

---

## 18. Recommended MVP

Fokus awal:

```txt
1 niche aktif
1 daftar link video YouTube mingguan
1 video diproses per hari
1 clip output
1 caption AI
1 thumbnail frame + text overlay
1 publish Instagram
1 FTP upload
1 cleanup setelah sukses
1 dashboard CRUD sederhana
```

Pengembangan setelah stabil:

```txt
channel/playlist mode
auto-search video
multi-post per hari
multi-platform
analytics engagement
auto scoring berdasarkan performa
AI thumbnail lebih kompleks
```

---

## 19. Skill Instruction untuk Sistem

```txt
SKILL NAME:
Podcast Clipper Content Automation

OBJECTIVE:
Menjalankan otomasi produksi dan publikasi konten pendek dari link video YouTube berdasarkan tema aktif, daftar link video mingguan, hasil clipper, transkrip, caption AI, thumbnail AI, FTP storage, dan publish otomatis ke Instagram.

IMPLEMENTATION RULE:
Kerjakan dan uji di localhost terlebih dahulu. Jangan langsung deploy ke GitHub sebelum pipeline lokal berhasil dari input link YouTube sampai output MP4, metadata, caption, thumbnail, upload FTP, dan validasi public URL.

DAILY FLOW:
1. Baca tema aktif.
2. Baca daftar link video YouTube aktif.
3. Pilih video terbaik berdasarkan target_date, priority, status queued, dan anti-duplikasi.
4. Buat job_id unik.
5. Kirim URL video ke sistem clipper.
6. Pantau status clipper sampai selesai.
7. Ambil output MP4, metadata JSON, transkrip, subtitle, dan log.
8. Buat caption berdasarkan transkrip.
9. Buat teks thumbnail berdasarkan hook utama.
10. Buat thumbnail dari frame video atau visual AI.
11. Upload video, thumbnail, dan metadata ke FTP.
12. Validasi public URL.
13. Publish otomatis ke Instagram.
14. Simpan media ID dan history publish.
15. Cleanup file sementara setelah publish sukses.

SOURCE RULES:
- Gunakan link video YouTube dari dashboard sebagai sumber utama.
- Channel, playlist, dan auto-search hanya menjadi fitur tambahan jika diaktifkan.
- Jangan proses video yang sudah pernah diproses.
- Jangan publish video yang sudah pernah dipublish.

COOKIES RULES:
- Jalankan tanpa cookies terlebih dahulu.
- Jika YouTube meminta login atau bot-check, gunakan cookies.txt.
- Jangan commit cookies.txt ke repository.
- Untuk lokal, boleh gunakan cookies dari browser.
- Untuk deployment, gunakan cookies yang disimpan secara aman.
- Jangan tampilkan cookies dalam log.

FTP RULES:
- FTP adalah storage persisten utama.
- Simpan video, thumbnail, metadata, log, dan history ke FTP.
- Public URL dari FTP harus bisa diakses Instagram Graph API.
- Jangan publish jika public URL tidak valid.

CAPTION RULES:
- Caption harus berdasarkan transkrip.
- Bahasa Indonesia.
- Hook kuat di awal.
- Tidak mengarang fakta.
- Ada CTA dan hashtag.

THUMBNAIL RULES:
- Teks thumbnail singkat dan kuat.
- Mudah dibaca di HP.
- Tidak menyesatkan isi video.
- Frame video asli + text overlay adalah default MVP.

PUBLISH RULES:
- Publish hanya jika semua validasi sukses.
- Jika publish sukses, simpan Instagram media ID.
- Jika publish gagal, jangan hapus file dan simpan error.

CLEANUP RULES:
- Cleanup hanya setelah publish sukses.
- Simpan metadata dan history.
- Hapus file besar atau file sementara jika sudah aman.

SUCCESS CRITERIA:
Sistem dianggap berhasil jika setiap hari menghasilkan minimal satu konten dengan status published, memiliki video final, caption final, thumbnail final, public URL, Instagram media ID, dan riwayat proses lengkap.
```

---

## 20. Catatan Keamanan

Jangan menyimpan data berikut di repository:

```txt
.env
cookies.txt
API key
access token
FTP password
Meta App Secret
Deepgram key
Gemini key
Hugging Face token
```

Gunakan:

```txt
.env lokal untuk development
GitHub Secrets untuk deployment
secret storage untuk cookies
```

Jika credential pernah terlanjur dibagikan ke chat, log, atau repository, anggap sudah bocor dan lakukan rotasi.

---

## 21. Kesimpulan

Sistem ini memakai **link video YouTube manual sebagai input utama**.

Channel, playlist, dan auto-search hanya opsi tambahan.

Urutan pengembangan yang benar:

```txt
localhost dulu
→ local end-to-end test
→ FTP upload test
→ public URL validation
→ manual trigger di GitHub
→ cron GitHub
→ production stabilization
```

Kunci sistem stabil:

```txt
input link video jelas
job_id jelas
status jelas
metadata lengkap
anti duplikasi
cookies aman
FTP rapi
public URL valid
caption sesuai transkrip
thumbnail kuat
history tersimpan
cleanup aman
```

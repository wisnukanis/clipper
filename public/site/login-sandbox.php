<?php
session_start();

$defaultRedirectUri = 'https://clipper.emsa.pro/auth/tiktok/callback.php';
$config = [
  'client_key' => getenv('TIKTOK_CLIENT_KEY') ?: '',
  'client_secret' => getenv('TIKTOK_CLIENT_SECRET') ?: '',
  'redirect_uri' => getenv('TIKTOK_REDIRECT_URI') ?: $defaultRedirectUri,
  'scopes' => getenv('TIKTOK_AUTH_SCOPES') ?: 'user.info.basic,video.upload,video.publish',
];
$configFile = __DIR__ . '/config/tiktok-sandbox.php';
if (is_file($configFile)) {
  $loadedConfig = include $configFile;
  if (is_array($loadedConfig)) {
    $config = array_merge($config, $loadedConfig);
  }
}

$message = '';
$error = '';

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function mask_value($value) {
  $text = (string) $value;
  if ($text === '') return 'empty';
  return substr($text, 0, 6) . '...' . substr($text, -4);
}

function build_auth_url($config) {
  $params = [
    'client_key' => $config['client_key'],
    'response_type' => 'code',
    'scope' => $config['scopes'],
    'redirect_uri' => $config['redirect_uri'],
    'state' => bin2hex(random_bytes(16)),
  ];
  $_SESSION['tiktok_demo_state'] = $params['state'];
  return 'https://www.tiktok.com/v2/auth/authorize/?' . http_build_query($params);
}

function curl_form($url, $fields) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query($fields),
    CURLOPT_HTTPHEADER => [
      'Content-Type: application/x-www-form-urlencoded',
      'Cache-Control: no-cache',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 60,
  ]);
  $raw = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $curlError = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new Exception('TikTok OAuth curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('TikTok OAuth returned non JSON response.');
  if ($status < 200 || $status >= 300) {
    $detail = $data['error_description'] ?? $data['message'] ?? json_encode($data);
    throw new Exception('TikTok OAuth failed: ' . $detail);
  }
  return $data;
}

function curl_json($url, $token, $payload) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($payload),
    CURLOPT_HTTPHEADER => [
      'Authorization: Bearer ' . $token,
      'Content-Type: application/json; charset=UTF-8',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 120,
  ]);
  $raw = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $curlError = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new Exception('TikTok API curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('TikTok API returned non JSON response.');
  $code = $data['error']['code'] ?? '';
  if ($status < 200 || $status >= 300 || ($code && $code !== 'ok')) {
    $detail = $data['error']['message'] ?? $data['message'] ?? json_encode($data);
    throw new Exception('TikTok API failed: ' . $detail);
  }
  return $data;
}

function tiktok_chunk_info($fileSize) {
  $defaultChunkSize = 10 * 1000 * 1000;
  $chunkSize = $fileSize <= 64 * 1000 * 1000 ? $fileSize : $defaultChunkSize;
  $totalChunkCount = $fileSize <= $chunkSize ? 1 : (int) floor($fileSize / $chunkSize);
  return [$chunkSize, max(1, $totalChunkCount)];
}

function upload_chunks($uploadUrl, $filePath, $fileSize, $chunkSize, $totalChunkCount) {
  $handle = fopen($filePath, 'rb');
  if (!$handle) throw new Exception('Tidak bisa membaca file video demo.');
  try {
    for ($index = 0; $index < $totalChunkCount; $index++) {
      $start = $index * $chunkSize;
      $end = $index === $totalChunkCount - 1 ? $fileSize - 1 : min($start + $chunkSize, $fileSize) - 1;
      $length = $end - $start + 1;
      fseek($handle, $start);
      $chunk = fread($handle, $length);
      $ch = curl_init($uploadUrl);
      curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => 'PUT',
        CURLOPT_POSTFIELDS => $chunk,
        CURLOPT_HTTPHEADER => [
          'Content-Type: video/mp4',
          'Content-Length: ' . strlen($chunk),
          'Content-Range: bytes ' . $start . '-' . $end . '/' . $fileSize,
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 900,
      ]);
      $raw = curl_exec($ch);
      $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
      $curlError = curl_error($ch);
      curl_close($ch);
      if ($raw === false || $status < 200 || $status >= 300) {
        throw new Exception('TikTok upload chunk failed: ' . ($curlError ?: $raw));
      }
    }
  } finally {
    fclose($handle);
  }
}

function latest_demo_video() {
  $jobsFile = __DIR__ . '/ig-generated/state/jobs.json';
  if (!is_file($jobsFile)) return null;
  $jobs = json_decode(file_get_contents($jobsFile), true);
  if (!is_array($jobs)) return null;
  usort($jobs, function ($a, $b) {
    return strcmp((string) ($b['updated_at'] ?? $b['created_at'] ?? ''), (string) ($a['updated_at'] ?? $a['created_at'] ?? ''));
  });
  foreach ($jobs as $job) {
    if (!empty($job['public_video_url'])) {
      return [
        'job_id' => $job['job_id'] ?? '',
        'title' => $job['source_title'] ?? $job['title'] ?? $job['job_id'] ?? 'Demo video',
        'caption' => $job['caption'] ?? 'Clipper Emsa Pro TikTok Sandbox demo',
        'url' => $job['public_video_url'],
      ];
    }
  }
  return null;
}

function local_video_path($videoUrl) {
  $parts = parse_url($videoUrl);
  if (($parts['host'] ?? '') !== 'clipper.emsa.pro') return '';
  $path = rawurldecode($parts['path'] ?? '');
  if (strpos($path, '/ig-generated/videos/') !== 0) return '';
  $candidate = realpath(__DIR__ . $path);
  $root = realpath(__DIR__ . '/ig-generated/videos');
  if (!$candidate || !$root || strpos($candidate, $root) !== 0) return '';
  return $candidate;
}

function publish_to_tiktok($token, $video) {
  $videoPath = local_video_path($video['url']);
  if ($videoPath && is_file($videoPath)) {
    $fileSize = filesize($videoPath);
    [$chunkSize, $totalChunkCount] = tiktok_chunk_info($fileSize);
    $init = curl_json('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', $token, [
      'source_info' => [
        'source' => 'FILE_UPLOAD',
        'video_size' => $fileSize,
        'chunk_size' => $chunkSize,
        'total_chunk_count' => $totalChunkCount,
      ],
    ]);
    $uploadUrl = $init['data']['upload_url'] ?? '';
    if (!$uploadUrl) throw new Exception('TikTok tidak mengembalikan upload_url.');
    upload_chunks($uploadUrl, $videoPath, $fileSize, $chunkSize, $totalChunkCount);
    return [
      'publish_id' => $init['data']['publish_id'] ?? '',
      'source' => 'FILE_UPLOAD',
      'mode' => 'inbox',
    ];
  }

  $init = curl_json('https://open.tiktokapis.com/v2/post/publish/inbox/video/init/', $token, [
    'source_info' => [
      'source' => 'PULL_FROM_URL',
      'video_url' => $video['url'],
    ],
  ]);
  return [
    'publish_id' => $init['data']['publish_id'] ?? '',
    'source' => 'PULL_FROM_URL',
    'mode' => 'inbox',
  ];
}

try {
  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'login') {
    $_SESSION['tiktok_demo_logged_in'] = true;
    header('Location: /login-sandbox.php');
    exit;
  }

  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'logout') {
    session_destroy();
    header('Location: /login-sandbox.php');
    exit;
  }

  if (!empty($_GET['tiktok_code'])) {
    if (!$config['client_key'] || !$config['client_secret']) {
      throw new Exception('TikTok client key/secret belum dikonfigurasi di server.');
    }
    $token = curl_form('https://open.tiktokapis.com/v2/oauth/token/', [
      'client_key' => $config['client_key'],
      'client_secret' => $config['client_secret'],
      'code' => trim($_GET['tiktok_code']),
      'grant_type' => 'authorization_code',
      'redirect_uri' => $config['redirect_uri'],
    ]);
    $_SESSION['tiktok_demo_token'] = $token;
    header('Location: /login-sandbox.php?connected=1');
    exit;
  }

  if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'publish') {
    $token = $_SESSION['tiktok_demo_token']['access_token'] ?? '';
    if (!$token) throw new Exception('Akun TikTok Sandbox belum terhubung.');
    $video = latest_demo_video();
    if (!$video) throw new Exception('Belum ada video hasil workflow untuk demo.');
    $result = publish_to_tiktok($token, $video);
    $_SESSION['tiktok_demo_publish'] = [
      'ok' => true,
      'at' => date(DATE_ATOM),
      'job_id' => $video['job_id'],
      'title' => $video['title'],
      'video_url' => $video['url'],
      'publish_id' => $result['publish_id'] ?: 'submitted',
      'source' => $result['source'],
      'mode' => $result['mode'],
    ];
    header('Location: /login-sandbox.php?published=1');
    exit;
  }
} catch (Throwable $caught) {
  $error = $caught->getMessage();
}

$loggedIn = !empty($_SESSION['tiktok_demo_logged_in']);
$token = $_SESSION['tiktok_demo_token'] ?? null;
$connected = is_array($token) && !empty($token['access_token']);
$publish = $_SESSION['tiktok_demo_publish'] ?? null;
$video = latest_demo_video();
$authUrl = ($config['client_key'] && $config['redirect_uri']) ? build_auth_url($config) : '';

if (isset($_GET['connected'])) $message = 'Akun TikTok Sandbox berhasil terhubung.';
if (isset($_GET['published'])) $message = 'Video sandbox berhasil dikirim ke TikTok Content Posting API Sandbox.';
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clipper Emsa Pro Login (Sandbox)</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(255, 255, 255, 0.075);
      --line: rgba(255, 255, 255, 0.14);
      --text: #edf7ff;
      --muted: #a7b7c9;
      --cyan: #34d5e8;
      --ink: #061018;
      --good: #067647;
      --warn: #b54708;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      background:
        linear-gradient(rgba(7, 17, 31, 0.78), rgba(7, 17, 31, 0.94)),
        url("https://images.unsplash.com/photo-1492724441997-5dc865305da7?auto=format&fit=crop&w=1800&q=80") center / cover fixed;
      color: var(--text);
      font-family: "Segoe UI", Arial, sans-serif;
    }
    a { color: inherit; }
    header, main, footer { width: min(1120px, calc(100% - 32px)); margin-inline: auto; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 800; text-decoration: none; }
    .mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 8px; background: var(--cyan); color: var(--ink); font-weight: 900; }
    nav { display: flex; gap: 16px; flex-wrap: wrap; color: var(--muted); font-size: 14px; }
    nav a, footer a { color: var(--muted); text-decoration: none; }
    main { margin-top: 22px; margin-bottom: 56px; }
    .hero { display: grid; grid-template-columns: 1.1fr .9fr; gap: 22px; align-items: stretch; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 22px; backdrop-filter: blur(16px); box-shadow: 0 24px 70px rgba(0, 0, 0, 0.32); }
    .eyebrow { margin: 0 0 8px; color: var(--cyan); font-size: 12px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: clamp(42px, 8vw, 76px); line-height: .95; }
    h2 { font-size: 22px; }
    p { line-height: 1.55; }
    .lead { color: #dce8f4; font-size: 18px; max-width: 660px; }
    .btn { appearance: none; border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 8px; padding: 11px 15px; font-weight: 800; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; min-height: 42px; }
    .btn.primary { background: var(--cyan); color: var(--ink); border-color: var(--cyan); }
    .btn:disabled { opacity: .55; cursor: not-allowed; }
    .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    .status { display: inline-flex; align-items: center; border: 1px solid var(--line); border-radius: 999px; padding: 5px 10px; font-size: 13px; font-weight: 800; color: var(--muted); background: rgba(0,0,0,.22); }
    .status.ok { color: var(--good); border-color: #abefc6; background: #ecfdf3; }
    .status.warn { color: var(--warn); border-color: #fedf89; background: #fffaeb; }
    .steps { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 22px; }
    .step { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel); backdrop-filter: blur(16px); min-height: 112px; }
    .step span { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 999px; background: var(--cyan); color: var(--ink); font-weight: 800; margin-bottom: 10px; }
    .step strong, .step small { display: block; }
    .step small { color: var(--muted); margin-top: 6px; line-height: 1.35; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-top: 16px; }
    .muted { color: var(--muted); }
    .notice { border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-weight: 700; }
    .notice.ok { background: #ecfdf3; color: var(--good); border: 1px solid #abefc6; }
    .notice.err { background: #fef3f2; color: #b42318; border: 1px solid #fecdca; }
    code, pre { font-family: Consolas, monospace; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #101828; color: #eaecf0; border-radius: 8px; padding: 14px; margin: 12px 0 0; font-size: 13px; }
    footer { border-top: 1px solid var(--line); padding: 18px 0 28px; color: var(--muted); display: flex; gap: 16px; flex-wrap: wrap; }
    @media (max-width: 820px) {
      header, .hero, .grid, .steps { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/"><span class="mark">CE</span><span>Clipper Emsa Pro</span></a>
    <nav>
      <a href="/privacy-policy.php">Privacy Policy</a>
      <a href="/terms-of-service.php">Terms of Service</a>
      <a href="/login-sandbox.php">Login (Sandbox)</a>
    </nav>
  </header>

  <main>
    <?php if ($message): ?><div class="notice ok"><?= e($message) ?></div><?php endif; ?>
    <?php if ($error): ?><div class="notice err"><?= e($error) ?></div><?php endif; ?>

    <section class="hero">
      <div class="panel">
        <p class="eyebrow">Login (Sandbox)</p>
        <h1>Clipper Emsa Pro</h1>
        <p class="lead">Halaman sandbox untuk memperlihatkan alur website resmi, login aplikasi, Connect TikTok, authorize scope, callback, pilih video, publish, dan hasil sandbox.</p>
        <div class="row">
          <span class="status <?= $loggedIn ? 'ok' : 'warn' ?>"><?= $loggedIn ? 'Logged in' : 'Need login' ?></span>
          <span class="status <?= $connected ? 'ok' : 'warn' ?>"><?= $connected ? 'TikTok connected' : 'TikTok not connected' ?></span>
          <span class="status <?= $video ? 'ok' : 'warn' ?>"><?= $video ? 'Video ready' : 'No video yet' ?></span>
        </div>
      </div>
      <div class="panel">
        <h2>App Settings</h2>
        <p class="muted">Credential dibaca server-side dari config hosting, bukan dari browser.</p>
        <p><strong>Client Key:</strong> <code><?= e(mask_value($config['client_key'])) ?></code></p>
        <p><strong>Redirect URI:</strong><br><code><?= e($config['redirect_uri']) ?></code></p>
        <p><strong>Scopes:</strong><br><code><?= e($config['scopes']) ?></code></p>
      </div>
    </section>

    <section class="steps">
      <div class="step"><span>1</span><strong>Official website</strong><small>clipper.emsa.pro, Privacy Policy, Terms.</small></div>
      <div class="step"><span>2</span><strong>Login (Sandbox)</strong><small>User masuk ke dashboard aplikasi.</small></div>
      <div class="step"><span>3</span><strong>Connect TikTok</strong><small>Authorize scope Sandbox.</small></div>
      <div class="step"><span>4</span><strong>Publish result</strong><small>Upload video via Content Posting API.</small></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>1. Login (Sandbox)</h2>
        <?php if ($loggedIn): ?>
          <p class="muted">Session sandbox aktif.</p>
          <form method="post"><input type="hidden" name="action" value="logout"><button class="btn" type="submit">Logout Sandbox</button></form>
        <?php else: ?>
          <p class="muted">Klik tombol ini saat rekaman demo untuk memperlihatkan login ke dashboard aplikasi.</p>
          <form method="post"><input type="hidden" name="action" value="login"><button class="btn primary" type="submit">Login (Sandbox)</button></form>
        <?php endif; ?>
      </div>

      <div class="panel">
        <h2>2. Connect TikTok</h2>
        <p class="muted">Mengarah ke authorization TikTok Sandbox dengan scope yang diminta.</p>
        <?php if (!$loggedIn): ?>
          <button class="btn primary" type="button" disabled>Login dulu</button>
        <?php elseif (!$authUrl): ?>
          <button class="btn primary" type="button" disabled>Client key belum siap</button>
        <?php elseif ($connected): ?>
          <p><span class="status ok">Connected</span></p>
          <p class="muted">Scope: <code><?= e($token['scope'] ?? $config['scopes']) ?></code></p>
        <?php else: ?>
          <a class="btn primary" href="<?= e($authUrl) ?>">Connect TikTok</a>
        <?php endif; ?>
      </div>

      <div class="panel">
        <h2>3. Video Sandbox</h2>
        <?php if ($video): ?>
          <p><strong><?= e($video['title']) ?></strong></p>
          <p class="muted">Job: <code><?= e($video['job_id']) ?></code></p>
          <p><a href="<?= e($video['url']) ?>" target="_blank" rel="noreferrer">Buka video publik</a></p>
        <?php else: ?>
          <p class="muted">Belum ada video di <code>ig-generated/state/jobs.json</code>. Jalankan workflow sampai SFTP upload selesai.</p>
        <?php endif; ?>
      </div>

      <div class="panel">
        <h2>4. Publish to TikTok</h2>
        <p class="muted">Mode sandbox memakai inbox upload agar user menyelesaikan posting dari aplikasi TikTok.</p>
        <form method="post">
          <input type="hidden" name="action" value="publish">
          <button class="btn primary" type="submit" <?= (!$loggedIn || !$connected || !$video) ? 'disabled' : '' ?>>Publish to TikTok</button>
        </form>
        <?php if (is_array($publish)): ?>
          <pre><?= e(json_encode($publish, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)) ?></pre>
        <?php endif; ?>
      </div>
    </section>
  </main>

  <footer>
    <span>Clipper Emsa Pro</span>
    <a href="/privacy-policy.php">Privacy Policy</a>
    <a href="/terms-of-service.php">Terms of Service</a>
  </footer>
</body>
</html>

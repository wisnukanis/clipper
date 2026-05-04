<?php
$query = $_SERVER['QUERY_STRING'] ?? '';
header('Location: /login-sandbox.php' . ($query ? '?' . $query : ''), true, 302);
exit;

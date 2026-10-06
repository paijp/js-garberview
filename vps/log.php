<?php
// Log receiver for the VPS copy of gerberview. The page posts events as JSON;
// with "save Gerber data" on, it also posts each opened file as a raw body
// with ?file=<name>. Everything lands outside the web root in LOG_DIR:
//   log.jsonl            one event per line
//   files/<time>-<session>-<name>
const LOG_DIR = '/var/lib/gerberview';
const MAX_EVENT = 256 * 1024;
const MAX_FILE = 30 * 1024 * 1024;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
$session = preg_replace('/[^A-Za-z0-9]/', '', $_GET['session'] ?? '');
$session = substr($session, 0, 32) ?: 'none';

function append_log($rec) {
  $rec = ['time' => date('c'), 'ip' => $_SERVER['REMOTE_ADDR'] ?? ''] + $rec;
  file_put_contents(LOG_DIR . '/log.jsonl',
    json_encode($rec, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
}

if (isset($_GET['file'])) {
  $name = preg_replace('/[^A-Za-z0-9._-]/', '_', basename($_GET['file']));
  $name = substr($name, 0, 120) ?: 'file';
  $body = file_get_contents('php://input', false, null, 0, MAX_FILE + 1);
  if ($body === false || strlen($body) > MAX_FILE) { http_response_code(413); exit; }
  @mkdir(LOG_DIR . '/files', 0750);
  $saved = date('Ymd-His') . '-' . $session . '-' . $name;
  file_put_contents(LOG_DIR . '/files/' . $saved, $body);
  append_log(['session' => $session, 'kind' => 'file', 'data' => ['name' => $_GET['file'], 'saved' => $saved, 'size' => strlen($body)]]);
  http_response_code(204);
  exit;
}

$body = file_get_contents('php://input', false, null, 0, MAX_EVENT + 1);
if ($body === false || strlen($body) > MAX_EVENT) { http_response_code(413); exit; }
$ev = json_decode($body, true);
if (!is_array($ev)) { http_response_code(400); exit; }
append_log(['session' => $session, 'kind' => substr((string)($ev['kind'] ?? ''), 0, 40),
            'ua' => substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 300), 'data' => $ev['data'] ?? null]);
http_response_code(204);

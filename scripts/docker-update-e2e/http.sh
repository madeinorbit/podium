# Shared HTTP helpers for the packaged update gate.
#
# WHY THIS FILE EXISTS (POD-2731). A sandbox build died on
#
#   curl: (22) The requested URL returned error: 400
#
# and neither the human nor an agent could tell from the log WHICH request had
# been refused. `curl -f` is the cause on both counts: its message names no URL,
# and it throws the response body away — and the body is exactly where a tRPC
# refusal explains itself. So no request in this harness may use `-f`.
#
# Every request goes through http_capture, which keeps the status AND the body.
# http_request then reports a refusal on its own, so a caller cannot forget to;
# the old helper only spoke when the caller thought to run `jq -e .error` over a
# body curl had already discarded, which is why it stayed silent here.
#
# http_probe is the quiet variant, for the poll loops inside wait_for where a
# non-2xx is the expected answer while a service is still coming up. wait_for
# already names its label and the last output when it times out, so those must
# not report per attempt.

HTTP_STATUS=""
HTTP_BODY=""
HTTP_MAX_BODY_BYTES="${PODIUM_UPDATE_E2E_MAX_BODY_BYTES:-4000}"
# Extra curl arguments for the next call, e.g. (-k) for the run-local self-signed
# edge origin. Callers set it immediately around the call and clear it after.
HTTP_EXTRA_ARGS=()
# ONE SESSION PER INSTANCE, keyed by where the request runs (POD-2832).
#
# A password closes the `/trpc` guard, and every container here is a SEPARATE
# instance with its own credential — a coordinator cookie is meaningless to a
# fleet machine and vice versa. One global cookie therefore cannot work: it
# authenticates one instance and silently 401s the rest, which reads to a
# `wait_for` loop as "not ready yet" and times out with no mention of auth.
#
# The key is the container name, or `host` for calls curl makes from the host
# (which reach the coordinator on its published port). A missing entry is an
# error once setup closes the guard; the gate has no unauthenticated row.
declare -A HTTP_SESSION_COOKIE=()

# Sourceable on its own so the reporting can be tested without running the gate.
if ! declare -F say >/dev/null 2>&1; then
  say() { printf '[update-e2e] %s\n' "$*"; }
fi

# Run one request and keep both halves of the answer in HTTP_STATUS/HTTP_BODY.
#
# Returns 1 only when curl could not complete the request at all (connection
# refused, DNS, timeout), leaving HTTP_STATUS empty. A 4xx is a COMPLETED
# request and returns 0 here — deciding what a status means is the caller's job.
_http_capture() {
  local where=$1 quiet=$2 method=$3 url=$4 request=${5:-} raw exit_code=0
  HTTP_STATUS=""
  HTTP_BODY=""
  # -S turns curl's own transport errors back on under -s. A probe must not have
  # them: it runs hundreds of times inside a wait_for loop where failure is the
  # expected answer. A request that must succeed keeps them, on top of our report.
  local -a args=(-s -w '\n%{http_code}')
  if (( quiet == 0 )); then
    args+=(-S)
  fi
  if [[ "$method" == POST ]]; then
    args+=(-H 'content-type: application/json' -d "$request")
  fi
  if (( ${#HTTP_EXTRA_ARGS[@]} > 0 )); then
    args+=("${HTTP_EXTRA_ARGS[@]}")
  fi
  local session="${HTTP_SESSION_COOKIE[${where:-host}]:-}"
  if [[ -n "$session" ]]; then
    args+=(-H "cookie: podium_session=$session")
  fi
  if [[ -n "$where" ]]; then
    raw="$(container_exec "$where" curl "${args[@]}" "$url")" || exit_code=$?
  else
    raw="$(curl "${args[@]}" "$url")" || exit_code=$?
  fi
  (( exit_code == 0 )) || return 1
  # The status is written after a newline curl adds itself, so the LAST newline
  # separates it from a body that may contain any number of its own.
  HTTP_STATUS="${raw##*$'\n'}"
  HTTP_BODY="${raw%$'\n'*}"
}

http_capture() { _http_capture "" 0 "$@"; }
container_http_capture() { local container=$1; shift; _http_capture "$container" 0 "$@"; }

# Name a failing request: what was sent, where, and what came back.
report_http_failure() {
  local method=$1 url=$2 request=$3 status=$4 body=$5 where=${6:-}
  local subject="$method $url" shown message
  [[ -z "$where" ]] || subject="$subject (in $where)"
  {
    say "REQUEST FAILED: $subject"
    say "  status: ${status:-no response — the request never completed}"
    if [[ -n "$request" ]]; then
      say "  request body: ${request:0:$HTTP_MAX_BODY_BYTES}"
    fi
    if [[ -n "$body" ]]; then
      # Bounded so an HTML error page cannot bury the run, and said out loud so
      # a short body is never mistaken for a truncated one.
      shown="${body:0:$HTTP_MAX_BODY_BYTES}"
      if (( ${#body} > HTTP_MAX_BODY_BYTES )); then
        shown="$shown"$'\n'"[${#body} bytes total, truncated]"
      fi
      say "  response body:"
      sed 's/^/  | /' <<<"$shown"
      if message="$(jq -r '.error.json.message // .error.message // empty' \
        <<<"$body" 2>/dev/null)" && [[ -n "$message" ]]; then
        say "  refusal: $message"
      fi
    else
      say "  response body: (empty)"
    fi
  } >&2
}

_http_request() {
  local where=$1 method=$2 url=$3 request=${4:-}
  if ! _http_capture "$where" 0 "$method" "$url" "$request"; then
    report_http_failure "$method" "$url" "$request" "" "" "$where"
    return 1
  fi
  if [[ "$HTTP_STATUS" != 2?? ]]; then
    report_http_failure "$method" "$url" "$request" "$HTTP_STATUS" "$HTTP_BODY" "$where"
    return 1
  fi
}

# One request that must succeed. Reports itself fully if it does not.
http_request() { _http_request "" "$@"; }
container_http_request() { local container=$1; shift; _http_request "$container" "$@"; }

# One request whose failure is an ordinary answer (readiness polling). Silent by
# design: the caller is a wait_for loop that reports the label on timeout.
http_probe() {
  _http_capture "" 1 "$@" || return 1
  [[ "$HTTP_STATUS" == 2?? ]]
}
container_http_probe() {
  local container=$1
  shift
  _http_capture "$container" 1 "$@" || return 1
  [[ "$HTTP_STATUS" == 2?? ]]
}

# Fetch a URL that must succeed and write its body to stdout.
http_get() {
  http_request GET "$1" || return 1
  printf '%s\n' "$HTTP_BODY"
}
container_http_get() {
  container_http_request "$1" GET "$2" || return 1
  printf '%s\n' "$HTTP_BODY"
}

# Download a URL inside a container to a host file.
#
# Kept apart from http_get because the payload is a signed archive: it must never
# pass through a shell variable, and a body echoed on failure would be binary. So
# it lands on disk inside the container, the status comes back on its own, and
# only a FAILING download is read back — by then the body is an error page.
download_from_container() {
  local container=$1 url=$2 destination=$3
  local remote=/tmp/podium-update-e2e-download status=""
  container_exec "$container" rm -f "$remote"
  status="$(container_exec "$container" curl -sSL -o "$remote" \
    -w '%{http_code}' "$url")" || status=""
  if [[ "$status" != 2?? ]]; then
    local body=""
    body="$(container_exec "$container" head -c "$HTTP_MAX_BODY_BYTES" "$remote" \
      2>/dev/null)" || body=""
    report_http_failure GET "$url" "" "$status" "$body" "$container"
    container_exec "$container" rm -f "$remote"
    return 1
  fi
  container_exec "$container" cat "$remote" >"$destination"
  container_exec "$container" rm -f "$remote"
}

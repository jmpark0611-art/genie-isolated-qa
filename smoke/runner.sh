#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
# Never accept URLs, tokens, or runtime paths as workflow input.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
image=docker.io/library/node@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
cliUrl=https://github.com/supabase/cli/releases/download/v2.122.1/supabase_2.122.1_linux_amd64.tar.gz
sqlUrl=https://raw.githubusercontent.com/jmpark0611-art/bestchoice/6cb0b24748dae152e66f8f4639506dba53b618cf/supabase/migrations/20261115000000_vs_polls_and_votes.sql
work="$(mktemp -d "${RUNNER_TEMP:?}/genie-synthetic.XXXXXXXX")"
phase='bootstrap isolation'
trap 'rc=$?; if [[ "$work" == "$RUNNER_TEMP"/genie-synthetic.* && -d "$work" && ! -L "$work" ]]; then rm -rf -- "$work" || true; fi; if ((rc)); then printf "%s\n" "STOP: ${phase} failed; real smoke not passed." >&2; fi; exit "$rc"' EXIT
[[ "$USER" != root && "$(uname -m)" == x86_64 && "${RUNNER_ENVIRONMENT:-}" == github-hosted ]]
[[ "${GITHUB_RUN_ATTEMPT:-}" == 1 && "${GITHUB_EVENT_NAME:-}" == workflow_dispatch && "${GITHUB_REF:-}" == refs/heads/main ]]
# No project/external credentials or ambient GitHub token accepted by this job.
for name in SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_SERVICE_ROLE_KEY OPENAI_API_KEY VERCEL_TOKEN GITHUB_TOKEN GH_TOKEN; do
  [[ -z "${!name:-}" ]]
done
[[ "$(docker context show)" == default ]]
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]]
docker info >/dev/null 2>&1
docker pull --platform linux/amd64 "$image" >"$work/pull.log" 2>&1
[[ "$(docker image inspect -f '{{.Os}}/{{.Architecture}}' "$image")" == linux/amd64 ]]
phase='fetch and digest verification'
cf=(--disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 120)
curl "${cf[@]}" "$cliUrl" -o "$work/supabase.tgz"
printf '%s  %s\n' '3e54b98e5ead7be0a3b0753526833d4cc9a55304e4d57da0d72f1efc342738ea' "$work/supabase.tgz" | sha256sum --check --status
curl "${cf[@]}" "$sqlUrl" -o "$work/schema.sql"
printf '%s  %s\n' 'a11c228c811cf8f04030a6507755863a4a3c6a771f86caa5268db59c77a136f1' "$work/schema.sql" | sha256sum --check --status
[[ "$(sha256sum "$root/verify-loopback.mjs" | cut -d' ' -f1)" == 3aeeb506e58a72093dfc9b7782ec7aca4542c899ac5be89e61c9952bc818639e ]]
[[ "$(sha256sum "$root/edge/fixture.mjs" | cut -d' ' -f1)" == 47aa80573c6d8c8c51ae95d9af379b2806765d1d31d2035c25ba3089677dce1a ]]
mkdir -p "$work/prep/home" "$work/prep/project/supabase"
tar -xzf "$work/supabase.tgz" -C "$work/prep" --no-same-owner supabase
cp "$root/config.toml" "$work/prep/project/supabase/config.toml"
cp "$root/container.sh" "$work/prep/"
phase='disposable runtime identity'
# A numeric Docker user may not resolve via the image passwd database. Read
# only the pinned image's public account file, never the host's. No network,
# writable root, project bind, daemon socket, or credentials in this probe.
uid="$(id -u)"
gid="$(id -g)"
[[ "$uid" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[0-9]+$ ]]
identity=()
base=(--rm --init --pull never --platform linux/amd64 --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --user "$uid:$gid" --env HOME=/qa/home --env SUPABASE_TELEMETRY_DISABLED=true)
docker run "${base[@]}" --network none --read-only --entrypoint /bin/cat "$image" /etc/passwd >"$work/image.passwd"
# Preserve the image's complete account table and add only a missing runner
# identity. A duplicate/malformed identity fails closed.
match_count="$(awk -F: -v uid="$uid" 'NF != 7 { bad=1 } $3 == uid { count++ } END { if (bad || count > 1 || NR == 0) exit 1; print count+0 }' "$work/image.passwd")"
if [[ "$match_count" == 0 ]]; then
  ! grep -q '^geniefixture:' "$work/image.passwd"
  printf 'geniefixture:x:%s:%s:Synthetic CI identity:/qa/home:/usr/sbin/nologin\n' "$uid" "$gid" >>"$work/image.passwd"
  identity=(--mount "type=bind,src=$work/image.passwd,dst=/etc/passwd,readonly")
fi
phase='official native service preload'
# This first container can reach official artifact hosts, but has only pinned
# CLI, a generated local config, and no SQL, Edge fixture or app data mounted.
docker run "${base[@]}" "${identity[@]}" --network bridge --mount "type=bind,src=$work/prep,dst=/qa" "$image" bash /qa/container.sh prepare
phase='assemble synthetic-only offline payload'
mkdir -p "$work/prep/project/supabase/migrations"
install -m 600 "$work/schema.sql" "$work/prep/project/supabase/migrations/20261115000000_genie.sql"
mkdir -p "$work/prep/project/supabase/functions/vs-decide"
cp "$root/edge/"{index.ts,fixture.mjs} "$work/prep/project/supabase/functions/vs-decide/"
cp "$root/"{verify-loopback.mjs,status-guard.mjs} "$work/prep/"
phase='actual offline stack and smoke'
# No port forward, host networking, Docker socket, project checkout or token.
docker run "${base[@]}" "${identity[@]}" --network none --mount "type=bind,src=$work/prep,dst=/qa" "$image" bash /qa/container.sh smoke
echo 'PASS: real disposable Supabase smoke passed inside an offline test container.'

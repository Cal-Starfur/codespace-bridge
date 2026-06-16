---
name: devvit-pipeline
description: Use this skill whenever working on a Devvit game and the user wants to deploy, test, or monitor their Reddit game. Handles the real-world pipeline: push code to GitHub → GitHub Actions runs build check → user runs devvit upload in Codespace → Claude reads player comments on Reddit → summarizes feedback. Triggers when user says "deploy", "push to Reddit", "check feedback", "how's the game doing", "any comments", "playtest", "go live", "did the build pass", or "check Reddit". Eliminates tab switching between Claude, GitHub, Codespaces, and Reddit.
---

# Devvit Deploy Pipeline

The real workflow we established through trial and error:

```
Claude writes code
    ↓
GitHub push (via github-sync skill — approved by you)
    ↓
GitHub Actions runs BUILD CHECK automatically (52 seconds)
    ↓ build passes
Claude runs: git pull && devvit upload --just-do-it
    (via codespace-bridge relay — no tab switching needed)
    ↓ live on Reddit (~15 seconds)
Claude reads Reddit comments → summarizes feedback
    ↓
Claude knows what to fix next session
```

**Prerequisite:** bridge3.js must be running in the Wigglers_Room Codespace.
If it's not running, ask user to start it:
```bash
curl -o ~/bridge3.js https://raw.githubusercontent.com/Cal-Starfur/codespace-bridge/main/bridge3.js
export BRIDGE_TOKEN=<github_pat>
node ~/bridge3.js
```

**Why devvit upload currently stays in Codespace (working hypothesis):**
In testing, `devvit upload` hung indefinitely in GitHub Actions even with
`CI=true`, `yes |` piped in, and `DEVVIT_NO_INTERACTIVE=true` set.
Our best guess: it makes a Reddit API call to create a playtest subreddit
that requires an interactive TTY or times out silently in CI.

**This may not be a permanent limitation.** Things worth trying in future sessions:
- `devvit upload --help` — check if newer CLI versions added a `--no-interactive` or `--yes` flag
- Setting `FORCE_COLOR=0 CI=true` and redirecting stdin from `/dev/null`
- Running `devvit upload < /dev/null` to explicitly close stdin
- Checking if Devvit adds official CI support in future releases
- Asking in r/devvit or the Devvit Discord if anyone has solved this

If the self-improvement scripts find a pattern or a solution surfaces,
update this section and test it. The goal is eventually zero manual steps.

---

## STEP 0 — Bootstrap Every Session

```bash
python3 << 'BOOTSTRAP'
import re
from pathlib import Path

skill_path = '/mnt/skills/user/devvit-pipeline/SKILL.md'
content = Path(skill_path).read_text()
sections = re.findall(
    r'## EMBEDDED SCRIPT: .+?\n\*Write this to `(.+?)`\*\n\n```python\n(.*?)```',
    content, re.DOTALL
)
for target_path, code in sections:
    target = Path(target_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(code)
    print(f"✓ {target_path}")
print("Bootstrap complete.")
BOOTSTRAP
```

---

## STEP 1 — Set Credentials (Every Session, Never Saved)

```bash
python3 -c "
import json
from pathlib import Path

gh_token = input('GitHub token: ').strip()
reddit_id = input('Reddit client ID: ').strip()
reddit_secret = input('Reddit client secret: ').strip()
reddit_user = input('Reddit username: ').strip()
reddit_pass = input('Reddit password: ').strip()
subreddit = input('Subreddit (no r/): ').strip()

Path('/tmp/devvit-pipeline/memory').mkdir(parents=True, exist_ok=True)
Path('/tmp/devvit-pipeline/memory/pipeline_config.json').write_text(json.dumps({
    'github_token': gh_token,
    'github_owner': 'Cal-Starfur',
    'github_repo': 'Wigglers_Room',
    'reddit': {
        'client_id': reddit_id,
        'client_secret': reddit_secret,
        'username': reddit_user,
        'password': reddit_pass,
    },
    'subreddit': subreddit,
    'game_title_keyword': 'Wigglers',
}, indent=2))
print('✓ Credentials set for this session')
"
```

---

## The Real Session Flow

### After Claude pushes code to GitHub:

```bash
# 1. Check if the build passed
python3 /tmp/devvit-pipeline/scripts/pipeline.py status
```

If build is green → tell user:
**"Build passed ✓ — run this in your Codespace to go live:"**
```bash
git pull && devvit upload
```

**Why `git pull` first:** Claude pushes via the GitHub API directly, bypassing the normal git workflow. The Codespace local clone never sees those commits until you pull. Without it, `devvit upload` warns "Couldn't find README.md" because the file exists in the repo but not on disk. `git status` will show clean even though files are missing — git doesn't know about API-pushed commits until you pull.

If build failed → read the error and fix it before telling user to upload.

### After user runs devvit upload in Codespace:

```bash
# 2. Read player feedback
python3 /tmp/devvit-pipeline/scripts/pipeline.py feedback

# 3. Watch for new comments live
python3 /tmp/devvit-pipeline/scripts/pipeline.py monitor
```

---

## What the Build Check Does (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` runs on every push:
- Checkout code
- Node 20
- npm ci
- npm install -g devvit
- npm run build (tsc --noEmit + devvit build)

**52 seconds. Catches TypeScript errors before they reach production.**
**Does NOT run devvit upload — that stays in Codespace.**

---

## Commands

### Check build status
```bash
python3 /tmp/devvit-pipeline/scripts/pipeline.py status
```
Shows recent GitHub Actions runs — pass/fail, commit, duration.

### Read player feedback
```bash
python3 /tmp/devvit-pipeline/scripts/pipeline.py feedback
python3 /tmp/devvit-pipeline/scripts/pipeline.py feedback --since 30
```

### Watch comments live
```bash
python3 /tmp/devvit-pipeline/scripts/pipeline.py monitor
```

---

## Repo Structure (Cal-Starfur/Wigglers_Room)

```
.github/workflows/
└── deploy.yml          ← build check on every push

src/
└── main.tsx            ← Devvit blocks side (self-contained)

webroot/
├── index.html          ← main game HTML
├── game.js             ← game logic
└── style.css

devvit.yaml             ← app config (redis, realtime, reddit_api)
package.json            ← build: tsc --noEmit && devvit build
```

---

## What Claude Does Each Session

1. Bootstrap scripts
2. Check build status — did last push compile?
3. If build failed — fix the error, push again
4. If build passed — tell user to run `devvit upload` in Codespace
5. After upload — read Reddit comments and summarize feedback
6. Report any bug mentions back so next session knows what to fix

---

## ✅ SOLVED — Codespace Bridge (Repo Relay Mode)

**Goal achieved:** Claude runs `git pull && devvit upload --just-do-it` directly — user never switches tabs.

**Solution: `codespace-bridge` via GitHub repo relay**
Repo: https://github.com/Cal-Starfur/codespace-bridge

Instead of tunnels or SSH, the bridge uses the GitHub repo itself as an inbox/outbox:
- Claude writes a command to `relay/inbox.json` via `api.github.com`
- `bridge3.js` polls every 3s, runs the command, writes result to `relay/outbox.json`
- Claude reads the result — full round trip through `api.github.com` (always whitelisted)

**Why other approaches failed:**
- `gh` CLI: `release-assets.githubusercontent.com` blocked by egress
- Codespaces REST exec API: doesn't exist publicly
- ngrok: requires account
- localtunnel (`loca.lt`): blocked by egress
- GitHub port forwarding: requires GitHub session cookie even on "public" ports

**Session startup (one-time per Codespace session):**
```bash
curl -o ~/bridge3.js https://raw.githubusercontent.com/Cal-Starfur/codespace-bridge/main/bridge3.js
export BRIDGE_TOKEN=<github_pat>
node ~/bridge3.js
```

**Key details:**
- `devvit` lives at `/home/codespace/nvm/current/bin/devvit` — always use full path
- Fine-grained PAT has no gist scope — repo relay works, gists don't
- Token is the same GitHub PAT used for everything else
- Bridge polls every 3s; typical deploy round-trip ~10-15s
- Always get a fresh SHA before writing inbox to avoid 409 conflicts

**Claude's deploy function (use this pattern):**
```python
def run(cmd, cwd="/workspaces/Wigglers_Room", timeout_polls=36):
    cmd_id = str(uuid.uuid4())[:8]
    time.sleep(2)  # avoid SHA race
    _, sha = read_file('relay/inbox.json')
    write_file('relay/inbox.json', {"cmd": cmd, "id": cmd_id, "cwd": cwd}, sha, f"bridge: [{cmd_id}]")
    for i in range(timeout_polls):
        time.sleep(5)
        outbox, _ = read_file('relay/outbox.json')
        if outbox.get('id') == cmd_id and outbox.get('ready'):
            return outbox
    return {"error": "timeout"}
```

**Full deploy sequence Claude runs:**
```python
run("git pull")
run("/home/codespace/nvm/current/bin/devvit upload --just-do-it 2>&1", timeout_polls=36)
```

---

## Hard Rules

1. Don't run devvit upload from GitHub Actions until a working solution is confirmed — current attempts hang. Try new approaches and log results via session_log.py
2. Always check build status after a push — don't assume it passed
3. Never store credentials in this file — /tmp only
4. Always summarize Reddit feedback in plain English after deploy
5. If build fails, fix it before asking user to upload anything
6. **Claude drives the full deploy — never wait for the user. After every push: run `pipeline.py status`, and if green run `devvit upload` via the codespace-bridge relay. User never needs to switch tabs.**

---

## Troubleshooting

**Build fails** → Read the TypeScript error, fix in code, push again

**devvit upload hangs in CI** → Current workaround is to run it in Codespace.
This may be solvable — try `devvit upload < /dev/null` or check if newer
Devvit CLI versions added a non-interactive flag. Log what you tried in
the session log so the self-improvement scripts can track it.

**devvit upload warning about subreddit** → Normal. The warning
"We couldn't install your app to the new playtest subreddit" just means
it was already installed there. Upload still succeeded.

**Reddit API 401** → Reddit credentials expired. Re-run Step 1.

**No game post found** → Check subreddit name and game_title_keyword in config.

---

## EMBEDDED SCRIPT: tools/github_client.py
*Write this to `/tmp/devvit-pipeline/tools/github_client.py`*

```python
"""
tools/github_client.py — GitHub API Client
Full read/write access to a GitHub repository.

Import:
    from tools.github_client import GitHubClient
    gh = GitHubClient(token='ghp_...', owner='yourname', repo='wigglers')
"""

import json
import base64
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime


class GitHubClient:
    """
    Full GitHub REST API client.
    Supports: read files, write files, create branches, open PRs, commit history.
    """

    BASE = 'https://api.github.com'

    def __init__(self, token, owner, repo, default_branch='main'):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.default_branch = default_branch
        self.base_repo = f"{self.BASE}/repos/{owner}/{repo}"

    def _headers(self):
        return {
            'Authorization': f'token {self.token}',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'LeadDevSkill/1.0',
        }

    def _request(self, method, url, data=None):
        """Make an authenticated GitHub API request."""
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(url, data=body, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read()), resp.status
        except urllib.error.HTTPError as e:
            error_body = {}
            try:
                error_body = json.loads(e.read())
            except:
                pass
            raise GitHubError(e.code, error_body.get('message', str(e)), url)

    # ── Read Operations ────────────────────────────────────────────────────

    def get_file(self, path, branch=None):
        """
        Get file content from repo.
        Returns: {'content': str, 'sha': str, 'path': str, 'size': int}
        """
        branch = branch or self.default_branch
        url = f"{self.base_repo}/contents/{path}?ref={branch}"
        data, _ = self._request('GET', url)
        content = base64.b64decode(data['content']).decode('utf-8', errors='replace')
        return {
            'content': content,
            'sha': data['sha'],
            'path': data['path'],
            'size': data['size'],
            'url': data['html_url'],
        }

    def file_exists(self, path, branch=None):
        """Check if a file exists in the repo."""
        try:
            self.get_file(path, branch)
            return True
        except GitHubError as e:
            if e.status == 404:
                return False
            raise

    def list_files(self, path='', branch=None):
        """
        List files/directories at a path.
        Returns list of {'name', 'path', 'type' (file|dir), 'size'}
        """
        branch = branch or self.default_branch
        url = f"{self.base_repo}/contents/{path}?ref={branch}"
        data, _ = self._request('GET', url)
        if isinstance(data, list):
            return [{'name': f['name'], 'path': f['path'],
                     'type': f['type'], 'size': f.get('size', 0)} for f in data]
        return []

    def get_branch(self, branch=None):
        """Get branch info including latest commit SHA."""
        branch = branch or self.default_branch
        url = f"{self.base_repo}/branches/{branch}"
        data, _ = self._request('GET', url)
        return {
            'name': data['name'],
            'sha': data['commit']['sha'],
            'commit_url': data['commit']['url'],
        }

    def get_commit_history(self, path=None, branch=None, limit=10):
        """
        Get recent commits, optionally for a specific file.
        Returns list of {'sha', 'message', 'author', 'date'}
        """
        branch = branch or self.default_branch
        url = f"{self.base_repo}/commits?sha={branch}&per_page={limit}"
        if path:
            url += f"&path={path}"
        data, _ = self._request('GET', url)
        return [{
            'sha': c['sha'][:7],
            'message': c['commit']['message'].split('\n')[0],
            'author': c['commit']['author']['name'],
            'date': c['commit']['author']['date'][:10],
        } for c in data]

    # ── Write Operations ───────────────────────────────────────────────────

    def write_file(self, path, content, commit_message, branch=None, sha=None):
        """
        Create or update a file in the repo.
        If file exists, sha must be provided (get it from get_file()).
        Returns: {'commit_sha', 'file_url', 'branch'}
        """
        branch = branch or self.default_branch

        # Auto-get SHA if file exists and sha not provided
        if sha is None and self.file_exists(path, branch):
            existing = self.get_file(path, branch)
            sha = existing['sha']

        encoded = base64.b64encode(content.encode('utf-8')).decode('utf-8')
        payload = {
            'message': commit_message,
            'content': encoded,
            'branch': branch,
        }
        if sha:
            payload['sha'] = sha

        url = f"{self.base_repo}/contents/{path}"
        data, _ = self._request('PUT', url, payload)
        return {
            'commit_sha': data['commit']['sha'][:7],
            'file_url': data['content']['html_url'],
            'branch': branch,
            'path': path,
        }

    def delete_file(self, path, commit_message, branch=None):
        """Delete a file from the repo."""
        branch = branch or self.default_branch
        existing = self.get_file(path, branch)
        payload = {
            'message': commit_message,
            'sha': existing['sha'],
            'branch': branch,
        }
        url = f"{self.base_repo}/contents/{path}"
        data, _ = self._request('DELETE', url, payload)
        return {'commit_sha': data['commit']['sha'][:7]}

    # ── Branch Operations ──────────────────────────────────────────────────

    def create_branch(self, branch_name, from_branch=None):
        """Create a new branch from an existing one."""
        from_branch = from_branch or self.default_branch
        source = self.get_branch(from_branch)
        url = f"{self.base_repo}/git/refs"
        payload = {
            'ref': f'refs/heads/{branch_name}',
            'sha': source['sha'],
        }
        try:
            data, _ = self._request('POST', url, payload)
            return {'branch': branch_name, 'sha': source['sha']}
        except GitHubError as e:
            if e.status == 422:  # Branch already exists
                return {'branch': branch_name, 'sha': source['sha'], 'existed': True}
            raise

    def branch_exists(self, branch_name):
        """Check if a branch exists."""
        try:
            self.get_branch(branch_name)
            return True
        except GitHubError as e:
            if e.status == 404:
                return False
            raise

    # ── Pull Request Operations ────────────────────────────────────────────

    def create_pull_request(self, title, body, head_branch, base_branch=None):
        """
        Open a pull request.
        Returns: {'number', 'url', 'title'}
        """
        base_branch = base_branch or self.default_branch
        url = f"{self.base_repo}/pulls"
        payload = {
            'title': title,
            'body': body,
            'head': head_branch,
            'base': base_branch,
        }
        data, _ = self._request('POST', url, payload)
        return {
            'number': data['number'],
            'url': data['html_url'],
            'title': data['title'],
            'state': data['state'],
        }

    def list_pull_requests(self, state='open'):
        """List PRs. state: 'open' | 'closed' | 'all'"""
        url = f"{self.base_repo}/pulls?state={state}&per_page=10"
        data, _ = self._request('GET', url)
        return [{
            'number': pr['number'],
            'title': pr['title'],
            'url': pr['html_url'],
            'branch': pr['head']['ref'],
            'created': pr['created_at'][:10],
        } for pr in data]

    # ── Repo Info ──────────────────────────────────────────────────────────

    def get_repo_info(self):
        """Get basic repo information."""
        data, _ = self._request('GET', self.base_repo)
        return {
            'name': data['name'],
            'description': data.get('description', ''),
            'default_branch': data['default_branch'],
            'private': data['private'],
            'url': data['html_url'],
            'last_push': data['pushed_at'][:10],
        }

    def test_connection(self):
        """Verify credentials and repo access. Returns True or raises."""
        info = self.get_repo_info()
        print(f"✓ Connected to: {self.owner}/{self.repo}")
        print(f"  Branch: {info['default_branch']}")
        print(f"  Last push: {info['last_push']}")
        return True


class GitHubError(Exception):
    def __init__(self, status, message, url=''):
        self.status = status
        self.message = message
        self.url = url
        super().__init__(f"GitHub API {status}: {message}")

```

---

## EMBEDDED SCRIPT: tools/reddit_client.py
*Write this to `/tmp/devvit-pipeline/tools/reddit_client.py`*

```python
"""
tools/reddit_client.py — Reddit API Client
OAuth2 authenticated access to Reddit.
Handles token refresh automatically.

Usage:
    from tools.reddit_client import RedditClient
    reddit = RedditClient(
        client_id='your_client_id',
        client_secret='your_client_secret',
        username='your_reddit_username',
        password='your_reddit_password',
        user_agent='WigglersRoom/1.0'
    )
    posts = reddit.get_subreddit_posts('your_subreddit')
"""

import json
import base64
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timedelta


class RedditClient:
    """
    Reddit OAuth2 API client.
    Auto-refreshes access token when expired.
    """

    OAUTH_BASE = 'https://oauth.reddit.com'
    AUTH_URL = 'https://www.reddit.com/api/v1/access_token'

    def __init__(self, client_id, client_secret, username, password,
                 user_agent='DevvitPipeline/1.0'):
        self.client_id = client_id
        self.client_secret = client_secret
        self.username = username
        self.password = password
        self.user_agent = user_agent
        self._token = None
        self._token_expires = None

    # ── Auth ──────────────────────────────────────────────────────────────

    def _get_token(self):
        """Get or refresh OAuth2 access token."""
        if self._token and self._token_expires and datetime.now() < self._token_expires:
            return self._token

        credentials = base64.b64encode(
            f'{self.client_id}:{self.client_secret}'.encode()
        ).decode()

        data = urllib.parse.urlencode({
            'grant_type': 'password',
            'username': self.username,
            'password': self.password,
        }).encode()

        req = urllib.request.Request(
            self.AUTH_URL,
            data=data,
            headers={
                'Authorization': f'Basic {credentials}',
                'User-Agent': self.user_agent,
                'Content-Type': 'application/x-www-form-urlencoded',
            }
        )

        with urllib.request.urlopen(req) as resp:
            result = json.loads(resp.read())
            self._token = result['access_token']
            self._token_expires = datetime.now() + timedelta(seconds=result['expires_in'] - 60)
            return self._token

    def _headers(self):
        return {
            'Authorization': f'bearer {self._get_token()}',
            'User-Agent': self.user_agent,
            'Content-Type': 'application/json',
        }

    def _get(self, endpoint, params=None):
        url = f'{self.OAUTH_BASE}{endpoint}'
        if params:
            url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RedditError(e.code, endpoint)

    def _post(self, endpoint, data):
        url = f'{self.OAUTH_BASE}{endpoint}'
        encoded = urllib.parse.urlencode(data).encode()
        headers = self._headers()
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        req = urllib.request.Request(url, data=encoded, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise RedditError(e.code, endpoint)

    # ── Subreddit ─────────────────────────────────────────────────────────

    def get_subreddit_posts(self, subreddit, sort='new', limit=10):
        """
        Get recent posts from a subreddit.
        sort: 'new' | 'hot' | 'top'
        Returns list of post dicts.
        """
        data = self._get(f'/r/{subreddit}/{sort}', {'limit': limit})
        posts = []
        for child in data['data']['children']:
            p = child['data']
            posts.append({
                'id': p['id'],
                'fullname': p['name'],
                'title': p['title'],
                'url': f"https://reddit.com{p['permalink']}",
                'author': p['author'],
                'score': p['score'],
                'num_comments': p['num_comments'],
                'created': datetime.fromtimestamp(p['created_utc']).strftime('%Y-%m-%d %H:%M'),
                'flair': p.get('link_flair_text', ''),
                'is_self': p['is_self'],
            })
        return posts

    def find_game_post(self, subreddit, title_contains='Wigglers'):
        """Find the game post in a subreddit by title keyword."""
        posts = self.get_subreddit_posts(subreddit, sort='new', limit=25)
        for post in posts:
            if title_contains.lower() in post['title'].lower():
                return post
        # Also check hot
        posts_hot = self.get_subreddit_posts(subreddit, sort='hot', limit=25)
        for post in posts_hot:
            if title_contains.lower() in post['title'].lower():
                return post
        return None

    # ── Comments ──────────────────────────────────────────────────────────

    def get_comments(self, subreddit, post_id, limit=25):
        """
        Get comments on a post.
        Returns list of comment dicts sorted by newest.
        """
        data = self._get(f'/r/{subreddit}/comments/{post_id}',
                        {'limit': limit, 'sort': 'new'})
        comments = []
        if len(data) > 1:
            for child in data[1]['data']['children']:
                c = child['data']
                if c.get('body') and c.get('author') != 'AutoModerator':
                    comments.append({
                        'id': c['id'],
                        'author': c['author'],
                        'body': c['body'],
                        'score': c['score'],
                        'created': datetime.fromtimestamp(c['created_utc']).strftime('%Y-%m-%d %H:%M'),
                    })
        return comments

    def get_new_comments_since(self, subreddit, post_id, since_minutes=30):
        """Get comments posted in the last N minutes."""
        comments = self.get_comments(subreddit, post_id, limit=50)
        cutoff = datetime.now() - timedelta(minutes=since_minutes)
        return [c for c in comments
                if datetime.strptime(c['created'], '%Y-%m-%d %H:%M') > cutoff]

    # ── Post Submission ───────────────────────────────────────────────────

    def submit_post(self, subreddit, title, text=None, url=None, flair=None):
        """
        Submit a new post to a subreddit.
        Either text (self post) or url (link post).
        Returns post dict with id and url.
        """
        data = {
            'sr': subreddit,
            'title': title,
            'kind': 'self' if text else 'link',
            'resubmit': True,
            'nsfw': False,
            'spoiler': False,
        }
        if text:
            data['text'] = text
        if url:
            data['url'] = url
        if flair:
            data['flair_text'] = flair

        result = self._post('/api/submit', data)
        if result.get('success') or 'url' in str(result):
            post_data = result.get('jquery', [])
            # Extract URL from response
            url_out = None
            for item in post_data:
                if isinstance(item, list) and len(item) > 3:
                    if isinstance(item[3], list):
                        for sub in item[3]:
                            if isinstance(sub, str) and 'reddit.com/r/' in sub:
                                url_out = sub
            return {'success': True, 'url': url_out, 'raw': result}
        return {'success': False, 'raw': result}

    def post_comment(self, parent_fullname, text):
        """Post a comment on a post or reply to a comment."""
        result = self._post('/api/comment', {
            'parent': parent_fullname,
            'text': text,
        })
        return result

    # ── User & App Info ───────────────────────────────────────────────────

    def get_my_posts(self, limit=10):
        """Get posts submitted by the authenticated user."""
        data = self._get(f'/user/{self.username}/submitted',
                        {'limit': limit, 'sort': 'new'})
        posts = []
        for child in data['data']['children']:
            p = child['data']
            posts.append({
                'id': p['id'],
                'title': p['title'],
                'subreddit': p['subreddit'],
                'url': f"https://reddit.com{p['permalink']}",
                'num_comments': p['num_comments'],
                'score': p['score'],
                'created': datetime.fromtimestamp(p['created_utc']).strftime('%Y-%m-%d %H:%M'),
            })
        return posts

    def get_post(self, post_fullname):
        """Get a specific post by fullname (t3_xxxxx)."""
        data = self._get('/api/info', {'id': post_fullname})
        children = data['data']['children']
        if children:
            p = children[0]['data']
            return {
                'id': p['id'],
                'title': p['title'],
                'score': p['score'],
                'num_comments': p['num_comments'],
                'url': f"https://reddit.com{p['permalink']}",
                'created': datetime.fromtimestamp(p['created_utc']).strftime('%Y-%m-%d %H:%M'),
            }
        return None

    def test_connection(self):
        """Verify credentials work."""
        data = self._get('/api/v1/me')
        print(f"✓ Reddit connected as: u/{data.get('name', 'unknown')}")
        print(f"  Karma: {data.get('total_karma', 0)}")
        return True


class RedditError(Exception):
    def __init__(self, status, endpoint):
        self.status = status
        self.endpoint = endpoint
        super().__init__(f"Reddit API {status}: {endpoint}")

```

---

## EMBEDDED SCRIPT: tools/actions_client.py
*Write this to `/tmp/devvit-pipeline/tools/actions_client.py`*

```python
"""
tools/actions_client.py — GitHub Actions API Client
Trigger workflows, poll status, read logs.
Used to run devvit upload remotely after code push.

Usage:
    from tools.actions_client import ActionsClient
    actions = ActionsClient(token='ghp_...', owner='Cal-Starfur', repo='Wigglers_Room')
    run = actions.trigger_workflow('deploy.yml')
    result = actions.wait_for_completion(run['run_id'])
"""

import json
import time
import urllib.request
import urllib.error
import zipfile
import io
from datetime import datetime


class ActionsClient:
    """GitHub Actions API — trigger and monitor workflows."""

    BASE = 'https://api.github.com'

    def __init__(self, token, owner, repo):
        self.token = token
        self.owner = owner
        self.repo = repo
        self.base_repo = f'{self.BASE}/repos/{owner}/{repo}'

    def _headers(self):
        return {
            'Authorization': f'token {self.token}',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'DevvitPipeline/1.0',
        }

    def _request(self, method, url, data=None):
        body = json.dumps(data).encode() if data else None
        req = urllib.request.Request(url, data=body,
                                      headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req) as resp:
                content = resp.read()
                return json.loads(content) if content else {}, resp.status
        except urllib.error.HTTPError as e:
            body = {}
            try:
                body = json.loads(e.read())
            except:
                pass
            raise ActionsError(e.code, body.get('message', str(e)), url)

    # ── Workflow Management ───────────────────────────────────────────────

    def list_workflows(self):
        """List all workflows in the repo."""
        data, _ = self._request('GET', f'{self.base_repo}/actions/workflows')
        return [{
            'id': w['id'],
            'name': w['name'],
            'filename': w['path'].split('/')[-1],
            'state': w['state'],
        } for w in data.get('workflows', [])]

    def get_workflow_id(self, filename):
        """Get workflow ID by filename (e.g. 'deploy.yml')."""
        workflows = self.list_workflows()
        for w in workflows:
            if w['filename'] == filename:
                return w['id']
        return None

    def trigger_workflow(self, workflow_filename, branch='main', inputs=None):
        """
        Trigger a workflow dispatch event.
        Returns run info dict with run_id to poll.
        """
        workflow_id = self.get_workflow_id(workflow_filename)
        if not workflow_id:
            raise ActionsError(404, f"Workflow '{workflow_filename}' not found", '')

        payload = {'ref': branch}
        if inputs:
            payload['inputs'] = inputs

        self._request('POST',
            f'{self.base_repo}/actions/workflows/{workflow_id}/dispatches',
            payload
        )

        # Wait a moment then find the new run
        time.sleep(3)
        runs = self.get_recent_runs(workflow_id, limit=1)
        if runs:
            return runs[0]
        return {'workflow': workflow_filename, 'status': 'triggered'}

    # ── Run Monitoring ────────────────────────────────────────────────────

    def get_recent_runs(self, workflow_id=None, limit=5, branch='main'):
        """Get recent workflow runs."""
        url = f'{self.base_repo}/actions/runs?per_page={limit}&branch={branch}'
        if workflow_id:
            url += f'&workflow_id={workflow_id}'
        data, _ = self._request('GET', url)
        runs = []
        for r in data.get('workflow_runs', []):
            runs.append({
                'run_id': r['id'],
                'name': r['name'],
                'status': r['status'],        # queued, in_progress, completed
                'conclusion': r['conclusion'], # success, failure, cancelled, None
                'branch': r['head_branch'],
                'commit': r['head_sha'][:7],
                'created': r['created_at'][:16].replace('T', ' '),
                'updated': r['updated_at'][:16].replace('T', ' '),
                'url': r['html_url'],
            })
        return runs

    def get_run_status(self, run_id):
        """Get current status of a specific run."""
        data, _ = self._request('GET', f'{self.base_repo}/actions/runs/{run_id}')
        return {
            'run_id': run_id,
            'status': data['status'],
            'conclusion': data.get('conclusion'),
            'name': data['name'],
            'commit': data['head_sha'][:7],
            'url': data['html_url'],
            'duration_seconds': None,
        }

    def wait_for_completion(self, run_id, timeout_seconds=300, poll_interval=8):
        """
        Poll a run until it completes or times out.
        Returns final run status dict.
        Prints progress updates.
        """
        start = time.time()
        print(f"Waiting for run {run_id}...")

        while True:
            elapsed = int(time.time() - start)
            if elapsed > timeout_seconds:
                print(f"Timeout after {elapsed}s")
                return {'run_id': run_id, 'status': 'timeout', 'conclusion': None}

            status = self.get_run_status(run_id)

            if status['status'] == 'completed':
                conclusion = status['conclusion']
                icon = '✓' if conclusion == 'success' else '✗'
                print(f"{icon} Completed in {elapsed}s — {conclusion}")
                return status

            print(f"  [{elapsed}s] {status['status']}...")
            time.sleep(poll_interval)

    # ── Logs ─────────────────────────────────────────────────────────────

    def get_run_logs(self, run_id, max_lines=100):
        """
        Download and extract run logs.
        Returns log text (last max_lines lines).
        """
        url = f'{self.base_repo}/actions/runs/{run_id}/logs'
        req = urllib.request.Request(url, headers=self._headers())
        try:
            with urllib.request.urlopen(req) as resp:
                zip_data = resp.read()

            # Extract from zip
            with zipfile.ZipFile(io.BytesIO(zip_data)) as zf:
                all_logs = []
                for name in zf.namelist():
                    with zf.open(name) as f:
                        content = f.read().decode('utf-8', errors='replace')
                        all_logs.append(f"=== {name} ===\n{content}")

            combined = '\n'.join(all_logs)
            lines = combined.split('\n')
            # Return last N lines (most relevant)
            return '\n'.join(lines[-max_lines:])

        except urllib.error.HTTPError as e:
            if e.code == 410:
                return "Logs expired (>90 days old)"
            raise

    def get_job_logs(self, run_id):
        """Get logs broken down by job and step."""
        data, _ = self._request('GET',
            f'{self.base_repo}/actions/runs/{run_id}/jobs')
        jobs = []
        for job in data.get('jobs', []):
            steps = [{
                'name': s['name'],
                'status': s['status'],
                'conclusion': s.get('conclusion'),
                'number': s['number'],
            } for s in job.get('steps', [])]
            jobs.append({
                'name': job['name'],
                'status': job['status'],
                'conclusion': job.get('conclusion'),
                'steps': steps,
            })
        return jobs

    # ── Workflow File Creator ─────────────────────────────────────────────

    def generate_deploy_workflow(self, devvit_token_secret='DEVVIT_TOKEN'):
        """
        Generate a GitHub Actions workflow YAML for Devvit deployment.
        Push this to .github/workflows/deploy.yml in the repo.

        The workflow:
        1. Triggers on push to main OR manual dispatch
        2. Installs Node + dependencies
        3. Runs devvit upload using a stored secret
        """
        return f"""name: Deploy to Devvit

on:
  push:
    branches: [ main ]
  workflow_dispatch:
    inputs:
      reason:
        description: 'Reason for manual deploy'
        required: false
        default: 'Manual deploy from Claude'

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install Devvit CLI
        run: npm install -g devvit

      - name: Authenticate Devvit
        run: |
          echo "Authenticating with Devvit..."
          devvit login --token ${{{{ secrets.{devvit_token_secret} }}}}

      - name: Upload to Devvit
        run: |
          echo "Deploying Wigglers Room..."
          devvit upload
          echo "Deploy complete"

      - name: Report status
        if: always()
        run: |
          echo "Workflow: ${{{{ github.workflow }}}}"
          echo "Commit: ${{{{ github.sha }}}}"
          echo "Status: ${{{{ job.status }}}}"
"""


class ActionsError(Exception):
    def __init__(self, status, message, url=''):
        self.status = status
        self.message = message
        super().__init__(f"Actions API {status}: {message}")

```

---

## EMBEDDED SCRIPT: scripts/pipeline.py
*Write this to `/tmp/devvit-pipeline/scripts/pipeline.py`*

```python
#!/usr/bin/env python3
"""
scripts/pipeline.py — Full Devvit Deploy Pipeline
Orchestrates: push code → trigger deploy → monitor → read feedback

Usage:
    python3 pipeline.py deploy     # trigger deploy workflow + monitor
    python3 pipeline.py status     # check last deploy status
    python3 pipeline.py feedback   # read Reddit comments on game post
    python3 pipeline.py monitor    # watch for new comments (live)
    python3 pipeline.py setup      # push deploy workflow to repo
    python3 pipeline.py configure  # set credentials
"""

import sys, json, time, argparse
from pathlib import Path
from datetime import datetime

sys.path.insert(0, '/tmp/devvit-pipeline')

CONFIG_FILE = Path('/tmp/devvit-pipeline/memory/pipeline_config.json')


def load_config():
    if not CONFIG_FILE.exists():
        raise ValueError(
            "Not configured. Run: python3 pipeline.py configure"
        )
    return json.loads(CONFIG_FILE.read_text())

def save_config(config):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(config, indent=2))

def get_github_client():
    from tools.github_client import GitHubClient
    config = load_config()
    return GitHubClient(
        config['github_token'],
        config['github_owner'],
        config['github_repo'],
    )

def get_actions_client():
    from tools.actions_client import ActionsClient
    config = load_config()
    return ActionsClient(
        config['github_token'],
        config['github_owner'],
        config['github_repo'],
    )

def get_reddit_client():
    from tools.reddit_client import RedditClient
    config = load_config()
    rc = config.get('reddit', {})
    return RedditClient(
        client_id=rc['client_id'],
        client_secret=rc['client_secret'],
        username=rc['username'],
        password=rc['password'],
        user_agent=f"{config['github_repo']}/1.0 by u/{rc['username']}",
    )


# ── Configure ─────────────────────────────────────────────────────────────

def cmd_configure(args):
    """Save all pipeline credentials."""
    config = load_config() if CONFIG_FILE.exists() else {}

    print("\nGitHub credentials:")
    if getattr(args, 'github_token', None): config['github_token'] = args.github_token
    if getattr(args, 'github_owner', None): config['github_owner'] = args.github_owner
    if getattr(args, 'github_repo', None):  config['github_repo'] = args.github_repo

    print("Reddit credentials:")
    if not config.get('reddit'):
        config['reddit'] = {}
    if getattr(args, 'reddit_client_id', None):
        config['reddit']['client_id'] = args.reddit_client_id
    if getattr(args, 'reddit_client_secret', None):
        config['reddit']['client_secret'] = args.reddit_client_secret
    if getattr(args, 'reddit_username', None):
        config['reddit']['username'] = args.reddit_username
    if getattr(args, 'reddit_password', None):
        config['reddit']['password'] = args.reddit_password

    if getattr(args, 'subreddit', None):
        config['subreddit'] = args.subreddit
    if getattr(args, 'game_title_keyword', None):
        config['game_title_keyword'] = args.game_title_keyword

    save_config(config)
    print(f"\n✓ Config saved")

    # Test connections
    try:
        gh = get_github_client()
        gh.test_connection()
    except Exception as e:
        print(f"⚠️  GitHub: {e}")

    try:
        reddit = get_reddit_client()
        reddit.test_connection()
    except Exception as e:
        print(f"⚠️  Reddit: {e}")


# ── Setup ──────────────────────────────────────────────────────────────────

def cmd_setup(args):
    """
    Push the GitHub Actions deploy workflow to the repo.
    Only needs to be done once.
    """
    print("\n" + "="*60)
    print("SETUP — Push Deploy Workflow to GitHub")
    print("="*60)

    actions = get_actions_client()
    gh = get_github_client()

    # Check if workflow already exists
    existing = gh.file_exists('.github/workflows/deploy.yml')
    if existing and not getattr(args, 'force', False):
        print("✓ deploy.yml already exists in repo")
        print("  Use --force to overwrite")
        return

    # Generate workflow content
    workflow_yaml = actions.generate_deploy_workflow()

    print("\nWorkflow to push:")
    print("  .github/workflows/deploy.yml")
    print("  Triggers: push to main + manual dispatch")
    print("  Steps: checkout → node setup → npm ci → devvit upload")
    print()
    print("⚠️  IMPORTANT: You need to add DEVVIT_TOKEN to GitHub Secrets:")
    print("  GitHub repo → Settings → Secrets → Actions → New secret")
    print("  Name: DEVVIT_TOKEN")
    print("  Value: your Devvit auth token (run 'devvit tokens' in Codespaces to get it)")
    print()

    confirm = input("Push workflow? (yes/no): ").strip().lower()
    if confirm != 'yes':
        print("Cancelled.")
        return

    result = gh.write_file(
        path='.github/workflows/deploy.yml',
        content=workflow_yaml,
        commit_message='ci: add Devvit deploy workflow',
    )
    print(f"\n✓ Pushed: {result['file_url']}")
    print(f"  Commit: {result['commit_sha']}")
    print("\nNext: add DEVVIT_TOKEN secret, then run: python3 pipeline.py deploy")


# ── Deploy ─────────────────────────────────────────────────────────────────

def cmd_deploy(args):
    """Trigger deployment and monitor until complete."""
    print("\n" + "="*60)
    print("DEPLOYING WIGGLERS ROOM")
    print("="*60)

    actions = get_actions_client()

    # Check workflow exists
    workflow_id = actions.get_workflow_id('deploy.yml')
    if not workflow_id:
        print("✗ deploy.yml workflow not found in repo")
        print("  Run: python3 pipeline.py setup")
        return

    print(f"\nTriggering deploy workflow...")
    run = actions.trigger_workflow('deploy.yml', inputs={
        'reason': f'Deploy triggered from Claude — {datetime.now().strftime("%Y-%m-%d %H:%M")}'
    })

    run_id = run.get('run_id')
    if not run_id:
        print(f"✗ Could not get run ID — check GitHub Actions tab")
        return

    print(f"Run ID: {run_id}")
    print(f"URL: {run.get('url', 'check GitHub Actions')}")
    print()

    # Monitor
    result = actions.wait_for_completion(run_id, timeout_seconds=300)

    print()
    if result['conclusion'] == 'success':
        print("✓ DEPLOY SUCCESSFUL")
        print("  Wigglers Room is live on Reddit")

        # Read logs for confirmation
        try:
            jobs = actions.get_job_logs(run_id)
            for job in jobs:
                print(f"\n  Job: {job['name']} → {job['conclusion']}")
                for step in job['steps']:
                    icon = '✓' if step['conclusion'] == 'success' else '✗'
                    print(f"    {icon} {step['name']}")
        except:
            pass

        # Save deploy record
        _log_deploy(run_id, 'success')

        print("\nChecking for player feedback...")
        cmd_feedback(args)

    else:
        print(f"✗ DEPLOY FAILED — conclusion: {result['conclusion']}")
        print(f"  URL: {result.get('url', '')}")
        print("\nFetching logs...")
        try:
            logs = actions.get_run_logs(run_id, max_lines=50)
            print(logs)
        except Exception as e:
            print(f"Could not fetch logs: {e}")

        _log_deploy(run_id, result['conclusion'])


# ── Status ─────────────────────────────────────────────────────────────────

def cmd_status(args):
    """Show recent deploy status."""
    print("\n" + "="*60)
    print("DEPLOY STATUS")
    print("="*60)

    actions = get_actions_client()
    config = load_config()

    runs = actions.get_recent_runs(limit=5)
    if not runs:
        print("No recent runs found")
        return

    for run in runs:
        conclusion = run.get('conclusion') or run['status']
        icon = {'success': '✓', 'failure': '✗', 'cancelled': '○'}.get(conclusion, '?')
        print(f"\n{icon} {run['name']}")
        print(f"  Status:  {run['status']} / {conclusion}")
        print(f"  Branch:  {run['branch']} @ {run['commit']}")
        print(f"  Time:    {run['created']}")
        print(f"  URL:     {run['url']}")


# ── Feedback ───────────────────────────────────────────────────────────────

def cmd_feedback(args):
    """Read player comments on the game post."""
    print("\n" + "="*60)
    print("PLAYER FEEDBACK")
    print("="*60)

    config = load_config()
    reddit = get_reddit_client()

    subreddit = config.get('subreddit')
    keyword = config.get('game_title_keyword', 'Wigglers')

    if not subreddit:
        print("No subreddit configured. Run: python3 pipeline.py configure --subreddit yoursubreddit")
        return

    # Find the game post
    print(f"Looking for '{keyword}' post in r/{subreddit}...")
    post = reddit.find_game_post(subreddit, keyword)

    if not post:
        print(f"✗ No '{keyword}' post found in r/{subreddit}")
        print("  Has the game been posted yet?")
        return

    print(f"\n✓ Found: {post['title']}")
    print(f"  URL: {post['url']}")
    print(f"  Score: {post['score']} | Comments: {post['num_comments']}")
    print(f"  Posted: {post['created']}")

    # Get comments
    comments = reddit.get_comments(subreddit, post['id'], limit=20)

    if not comments:
        print("\n  No comments yet")
        return

    since_minutes = getattr(args, 'since', None)
    if since_minutes:
        comments = reddit.get_new_comments_since(subreddit, post['id'], since_minutes)
        print(f"\nNew comments (last {since_minutes} min): {len(comments)}")
    else:
        print(f"\nRecent comments ({len(comments)}):")

    for c in comments[:10]:
        print(f"\n  u/{c['author']} [{c['created']}] ↑{c['score']}")
        # Wrap long comments
        body = c['body'].replace('\n', ' ')
        if len(body) > 200:
            body = body[:197] + '...'
        print(f"  {body}")

    # Summary for Claude to act on
    if len(comments) > 0:
        print(f"\n{'─'*60}")
        print(f"SUMMARY FOR ACTION:")
        print(f"  Total comments: {len(comments)}")
        bug_words = ['bug', 'broken', 'crash', 'error', 'doesn\'t work', 'not working', 'fix']
        bugs = [c for c in comments if any(w in c['body'].lower() for w in bug_words)]
        if bugs:
            print(f"  Possible bug reports: {len(bugs)}")
            for b in bugs[:3]:
                print(f"    → u/{b['author']}: {b['body'][:100]}")

    # Save post ID for future calls
    config['last_game_post_id'] = post['id']
    config['last_game_post_url'] = post['url']
    save_config(config)


# ── Monitor ────────────────────────────────────────────────────────────────

def cmd_monitor(args):
    """Watch for new comments on the game post (polls every 60s)."""
    config = load_config()
    reddit = get_reddit_client()
    subreddit = config.get('subreddit')
    keyword = config.get('game_title_keyword', 'Wigglers')

    post = reddit.find_game_post(subreddit, keyword)
    if not post:
        print(f"✗ No game post found in r/{subreddit}")
        return

    print(f"\nMonitoring: {post['title']}")
    print(f"URL: {post['url']}")
    print("Checking for new comments every 60 seconds... (Ctrl+C to stop)\n")

    seen_ids = set()
    while True:
        try:
            comments = reddit.get_comments(subreddit, post['id'], limit=25)
            new = [c for c in comments if c['id'] not in seen_ids]
            for c in new:
                print(f"[{c['created']}] u/{c['author']}: {c['body'][:150]}")
                seen_ids.add(c['id'])
            time.sleep(60)
        except KeyboardInterrupt:
            print("\nStopped monitoring.")
            break


# ── Deploy Log ─────────────────────────────────────────────────────────────

def _log_deploy(run_id, conclusion):
    log_path = Path('/tmp/devvit-pipeline/memory/deploy_log.jsonl')
    log_path.parent.mkdir(exist_ok=True)
    entry = {
        'timestamp': datetime.now().isoformat(),
        'run_id': run_id,
        'conclusion': conclusion,
    }
    with open(log_path, 'a') as f:
        f.write(json.dumps(entry) + '\n')


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Devvit Deploy Pipeline')
    subparsers = parser.add_subparsers(dest='command')

    # configure
    p = subparsers.add_parser('configure', help='Set all credentials')
    p.add_argument('--github-token')
    p.add_argument('--github-owner')
    p.add_argument('--github-repo')
    p.add_argument('--reddit-client-id')
    p.add_argument('--reddit-client-secret')
    p.add_argument('--reddit-username')
    p.add_argument('--reddit-password')
    p.add_argument('--subreddit')
    p.add_argument('--game-title-keyword', default='Wigglers')

    # setup
    p = subparsers.add_parser('setup', help='Push deploy workflow to repo')
    p.add_argument('--force', action='store_true')

    # deploy
    subparsers.add_parser('deploy', help='Trigger deploy and monitor')

    # status
    subparsers.add_parser('status', help='Show recent deploy runs')

    # feedback
    p = subparsers.add_parser('feedback', help='Read player comments')
    p.add_argument('--since', type=int, help='Only show comments from last N minutes')

    # monitor
    subparsers.add_parser('monitor', help='Watch for new comments live')

    args = parser.parse_args()

    commands = {
        'configure': cmd_configure,
        'setup': cmd_setup,
        'deploy': cmd_deploy,
        'status': cmd_status,
        'feedback': cmd_feedback,
        'monitor': cmd_monitor,
    }

    if args.command in commands:
        commands[args.command](args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()

```

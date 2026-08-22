async function exchangeCode(code, redirectUri) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !secret) return { error: "oauth_not_configured" };
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: secret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json();
  if (!token.access_token) return { error: "token_failed", detail: token };
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": "relay-it" },
  });
  const gh = await userRes.json();
  return {
    user: {
      id: `gh_${gh.id}`,
      login: gh.login,
      name: gh.name || gh.login,
      avatarUrl: gh.avatar_url,
    },
  };
}

function authorizeUrl(redirectUri) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) return null;
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "read:user",
  });
  return `https://github.com/login/oauth/authorize?${q}`;
}

module.exports = { exchangeCode, authorizeUrl };

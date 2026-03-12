import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { debug } from "../utils/logger";
import type { ClaudeHookData } from "../utils/claude";

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_REFRESH_ENDPOINT = "https://platform.claude.com/v1/oauth/token";
const BETA_HEADER = "oauth-2025-04-20";
const CACHE_TTL_MS = 300_000; // 5 minutes - increased due to OAuth API 429 rate limiting (Issue #31021)
const FALLBACK_CLAUDE_VERSION = "2.1.0";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export interface RateLimitsInfo {
  session?: {
    usedPercentage: number;
    resetsAt: string | null;
  };
  weekly?: {
    usedPercentage: number;
    resetsAt: string | null;
  };
  extraUsage?: {
    enabled: boolean;
    usedDollars: number;
    limitDollars: number;
    currency: string;
  };
}

interface OAuthUsageResponse {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number;
    currency?: string;
  };
}

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    rateLimitTier?: string;
  };
}

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface CacheEntry {
  data: RateLimitsInfo;
  timestamp: number;
}

export class RateLimitsProvider {
  private static readonly cacheDir = join(tmpdir(), "claude-powerline");
  private static readonly cacheFile = join(
    RateLimitsProvider.cacheDir,
    "rate-limits-cache.json",
  );
  private static readonly tokenCacheFile = join(
    RateLimitsProvider.cacheDir,
    "token-cache.json",
  );

  private cachedClaudeVersion: string | null = null;

  async getRateLimitsInfo(
    hookData: ClaudeHookData,
  ): Promise<RateLimitsInfo | null> {
    if (hookData.rate_limits) {
      const rl = hookData.rate_limits;
      return {
        session: rl.session
          ? {
              usedPercentage: rl.session.used_percentage,
              resetsAt: rl.session.resets_at,
            }
          : undefined,
        weekly: rl.weekly
          ? {
              usedPercentage: rl.weekly.used_percentage,
              resetsAt: rl.weekly.resets_at,
            }
          : undefined,
      };
    }

    return this.fetchFromOAuthAPI();
  }

  private async fetchFromOAuthAPI(): Promise<RateLimitsInfo | null> {
    const cached = await this.readCache();
    if (cached) return cached;

    const tokenData = await this.loadAccessTokenWithRefresh();
    if (!tokenData) {
      debug("No OAuth access token found");
      return null;
    }

    const userAgent = await this.getClaudeUserAgent();

    try {
      const response = await fetch(USAGE_ENDPOINT, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokenData.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": BETA_HEADER,
          "User-Agent": userAgent,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        debug(
          `OAuth usage API returned ${response.status}: ${response.statusText}`,
        );
        return null;
      }

      const data = (await response.json()) as OAuthUsageResponse;
      const info = this.parseUsageResponse(data);
      await this.writeCache(info);
      return info;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`Failed to fetch OAuth usage: ${msg}`);
      return null;
    }
  }

  private parseUsageResponse(data: OAuthUsageResponse): RateLimitsInfo {
    const info: RateLimitsInfo = {};

    if (data.five_hour?.utilization !== undefined) {
      info.session = {
        usedPercentage: data.five_hour.utilization,
        resetsAt: data.five_hour.resets_at ?? null,
      };
    }

    if (data.seven_day?.utilization !== undefined) {
      info.weekly = {
        usedPercentage: data.seven_day.utilization,
        resetsAt: data.seven_day.resets_at ?? null,
      };
    }

    if (data.extra_usage?.is_enabled) {
      const usedCents = data.extra_usage.used_credits ?? 0;
      const limitCents = data.extra_usage.monthly_limit ?? 0;
      info.extraUsage = {
        enabled: true,
        usedDollars: usedCents / 100,
        limitDollars: limitCents / 100,
        currency: data.extra_usage.currency?.trim() || "USD",
      };
    }

    return info;
  }

  private async getClaudeUserAgent(): Promise<string> {
    if (this.cachedClaudeVersion) {
      return `claude-code/${this.cachedClaudeVersion}`;
    }

    const version = await this.detectClaudeVersion();
    this.cachedClaudeVersion = version;
    return `claude-code/${version}`;
  }

  private detectClaudeVersion(): Promise<string> {
    return new Promise((resolve) => {
      execFile(
        "claude",
        ["--version"],
        { timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(FALLBACK_CLAUDE_VERSION);
            return;
          }
          const trimmed = stdout.trim().split(/\s+/)[0];
          resolve(trimmed || FALLBACK_CLAUDE_VERSION);
        },
      );
    });
  }

  private async loadAccessTokenWithRefresh(): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  } | null> {
    const creds = await this.loadCredentials();
    const oauth = creds?.claudeAiOauth;
    const accessToken = oauth?.accessToken;

    if (!accessToken) {
      return null;
    }

    const now = Date.now();

    if (oauth.expiresAt && oauth.expiresAt < now && oauth.refreshToken) {
      debug("Access token expired, attempting refresh");
      const refreshed = await this.refreshAccessToken(oauth.refreshToken);
      if (refreshed) {
        await this.saveRefreshedToken(refreshed);
        return {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token,
          expiresAt: now + refreshed.expires_in * 1000,
        };
      }
      debug("Token refresh failed, using existing token");
    }

    return {
      accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
    };
  }

  private async refreshAccessToken(
    refreshToken: string,
  ): Promise<TokenRefreshResponse | null> {
    try {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      });

      const response = await fetch(TOKEN_REFRESH_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        debug(`Token refresh failed: ${response.status}`);
        return null;
      }

      return (await response.json()) as TokenRefreshResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      debug(`Token refresh error: ${msg}`);
      return null;
    }
  }

  private async saveRefreshedToken(
    tokenData: TokenRefreshResponse,
  ): Promise<void> {
    try {
      if (!existsSync(RateLimitsProvider.cacheDir)) {
        await mkdir(RateLimitsProvider.cacheDir, { recursive: true });
      }

      const cache = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
      };

      await writeFile(
        RateLimitsProvider.tokenCacheFile,
        JSON.stringify(cache),
        "utf-8",
      );
    } catch (err) {
      debug(`Failed to save refreshed token: ${err}`);
    }
  }

  private async loadCredentials(): Promise<CredentialsFile | null> {
    const tokenCache = await this.loadTokenCache();
    if (tokenCache) {
      return {
        claudeAiOauth: tokenCache,
      };
    }

    const credentialsPath = join(homedir(), ".claude", ".credentials.json");
    if (existsSync(credentialsPath)) {
      try {
        const content = await readFile(credentialsPath, "utf-8");
        return JSON.parse(content) as CredentialsFile;
      } catch (err) {
        debug(`Failed to read credentials file: ${err}`);
      }
    }

    const keychainCreds = await this.readFromKeychain();
    if (keychainCreds) {
      return keychainCreds;
    }

    return null;
  }

  private async loadTokenCache(): Promise<CredentialsFile["claudeAiOauth"] | null> {
    try {
      if (!existsSync(RateLimitsProvider.tokenCacheFile)) return null;

      const content = await readFile(RateLimitsProvider.tokenCacheFile, "utf-8");
      const cache = JSON.parse(content) as {
        accessToken: string;
        refreshToken?: string;
        expiresAt?: number;
      };

      if (cache.expiresAt && cache.expiresAt < Date.now()) {
        return null;
      }

      return cache;
    } catch {
      return null;
    }
  }

  private readFromKeychain(): Promise<CredentialsFile | null> {
    return new Promise((resolve) => {
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout.trim()) {
            resolve(null);
            return;
          }
          try {
            const creds = JSON.parse(stdout.trim()) as CredentialsFile;
            resolve(creds);
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  private async readCache(): Promise<RateLimitsInfo | null> {
    try {
      if (!existsSync(RateLimitsProvider.cacheFile)) return null;

      const content = await readFile(RateLimitsProvider.cacheFile, "utf-8");
      const entry = JSON.parse(content) as CacheEntry;

      if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;

      return entry.data;
    } catch {
      return null;
    }
  }

  private async writeCache(data: RateLimitsInfo): Promise<void> {
    try {
      if (!existsSync(RateLimitsProvider.cacheDir)) {
        await mkdir(RateLimitsProvider.cacheDir, { recursive: true });
      }

      const entry: CacheEntry = { data, timestamp: Date.now() };
      await writeFile(
        RateLimitsProvider.cacheFile,
        JSON.stringify(entry),
        "utf-8",
      );
    } catch (err) {
      debug(`Failed to write rate limits cache: ${err}`);
    }
  }
}

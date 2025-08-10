#!/usr/bin/env bun

import * as core from "@actions/core";
import { createAppAuth } from "@octokit/auth-app";
import { retryWithBackoff } from "../utils/retry";

async function getOidcToken(): Promise<string> {
  try {
    const oidcToken = await core.getIDToken("claude-code-github-action");

    return oidcToken;
  } catch (error) {
    console.error("Failed to get OIDC token:", error);
    throw new Error(
      "Could not fetch an OIDC token. Did you remember to add `id-token: write` to your workflow permissions?",
    );
  }
}

async function exchangeForAppToken(oidcToken: string): Promise<string> {
  const response = await fetch(
    "https://api.anthropic.com/api/github/github-app-token-exchange",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oidcToken}`,
      },
    },
  );

  if (!response.ok) {
    const responseJson = (await response.json()) as {
      error?: {
        message?: string;
      };
    };
    console.error(
      `App token exchange failed: ${response.status} ${response.statusText} - ${responseJson?.error?.message ?? "Unknown error"}`,
    );
    throw new Error(`${responseJson?.error?.message ?? "Unknown error"}`);
  }

  const appTokenData = (await response.json()) as {
    token?: string;
    app_token?: string;
  };
  const appToken = appTokenData.token || appTokenData.app_token;

  if (!appToken) {
    throw new Error("App token not found in response");
  }

  return appToken;
}

async function getInstallationId(): Promise<number> {
  // Get installation ID from the repository context
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY environment variable not found");
  }

  const [owner, repoName] = repo.split("/");
  
  // Create a temporary auth instance to get installation
  const appId = process.env.REHEARSAL_APP_ID;
  const privateKey = process.env.REHEARSAL_APP_PRIVATE_KEY;
  
  if (!appId || !privateKey) {
    throw new Error("Rehearsal App credentials not found");
  }

  const auth = createAppAuth({
    appId,
    privateKey,
  });

  // Get app authentication to list installations
  const appAuth = await auth({ type: "app" });
  
  // Use the app token to find the installation for this repo
  const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/installation`, {
    headers: {
      Authorization: `Bearer ${appAuth.token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get installation ID: ${response.status} ${response.statusText}`);
  }

  const installation = await response.json() as { id: number };
  return installation.id;
}

async function generateRehearsalAppToken(): Promise<string> {
  const appId = process.env.REHEARSAL_APP_ID;
  const privateKey = process.env.REHEARSAL_APP_PRIVATE_KEY;

  if (!appId || !privateKey) {
    console.log("Rehearsal App credentials not provided, falling back to Claude App");
    return "";
  }

  try {
    console.log("Getting installation ID for Rehearsal App...");
    const installationId = await getInstallationId();
    console.log(`Found installation ID: ${installationId}`);

    console.log("Generating token from Rehearsal GitHub App...");
    const auth = createAppAuth({
      appId,
      privateKey,
      installationId,
    });

    const { token } = await auth({ type: "installation" });
    console.log("Successfully generated Rehearsal App token");
    return token;
  } catch (error) {
    console.error("Failed to generate Rehearsal App token:", error);
    console.log("Falling back to Claude App authentication");
    return "";
  }
}

export async function setupGitHubToken(): Promise<string> {
  try {
    // Check if GitHub token was provided as override
    const providedToken = process.env.OVERRIDE_GITHUB_TOKEN;

    if (providedToken) {
      console.log("Using provided GITHUB_TOKEN for authentication");
      core.setOutput("GITHUB_TOKEN", providedToken);
      return providedToken;
    }

    // Try to use Rehearsal App authentication first
    const rehearsalToken = await generateRehearsalAppToken();
    if (rehearsalToken) {
      console.log("Using Rehearsal App token for authentication");
      core.setOutput("GITHUB_TOKEN", rehearsalToken);
      return rehearsalToken;
    }

    // Fall back to Claude App via OIDC exchange
    console.log("Requesting OIDC token for Claude App fallback...");
    const oidcToken = await retryWithBackoff(() => getOidcToken());
    console.log("OIDC token successfully obtained");

    console.log("Exchanging OIDC token for Claude App token...");
    const appToken = await retryWithBackoff(() =>
      exchangeForAppToken(oidcToken),
    );
    console.log("App token successfully obtained (Claude App)");

    console.log("Using GITHUB_TOKEN from Claude App (fallback)");
    core.setOutput("GITHUB_TOKEN", appToken);
    return appToken;
  } catch (error) {
    core.setFailed(
      `Failed to setup GitHub token: ${error}.\n\nMake sure either:\n1. Rehearsal App is installed on this repository with REHEARSAL_APP_ID and REHEARSAL_APP_PRIVATE_KEY secrets set\n2. Or the Claude App integration is working with proper OIDC permissions`,
    );
    process.exit(1);
  }
}
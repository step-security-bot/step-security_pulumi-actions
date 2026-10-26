import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';

export function parseChecksums(contents: string): Map<string, string> {
  /**
   *  Parses a `sha256sum` style checksum file
   *  contents: body of the published checksums file
   *
   *  return map of file name to lower case digest
   */
  const checksums = new Map<string, string>();

  for (const line of contents.split('\n')) {
    // `<digest>  <name>`, where the name may carry a `*` binary mode marker
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
    if (match) {
      checksums.set(path.posix.basename(match[2]), match[1].toLowerCase());
    }
  }

  return checksums;
}

function sha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function findChecksum(
  checksums: Map<string, string>,
  fileName: string,
  platform?: string,
): string | undefined {
  /**
   *  Looks up the digest for a download
   *  checksums: parsed checksums file
   *  fileName: name of the downloaded file
   *  platform: the platform the download was picked for
   *
   *  return the digest, or undefined if the file is not listed
   */
  const exact = checksums.get(fileName);
  if (exact) {
    return exact;
  }

  // Dev builds are served as `pulumi-v3.1.0-alpha.xdeadbee-linux-x64.tar.gz`
  // but listed under the release version they were cut from, so fall back to
  // the platform. A checksums file covers one version with one entry per
  // platform, so insist on a single match rather than guessing.
  if (!platform) {
    return undefined;
  }

  const matches = [...checksums].filter(([name]) =>
    name.includes(`-${platform}.`),
  );

  return matches.length === 1 ? matches[0][1] : undefined;
}

export async function verifyChecksum(
  filePath: string,
  downloadUrl: string,
  checksumsUrl: string,
  platform?: string,
): Promise<void> {
  /**
   *  Verifies a downloaded file against the checksums Pulumi publishes
   *  alongside the release. A mismatch is fatal, but a checksum that cannot be
   *  located is only a warning: releases that predate the published checksum
   *  files must keep installing as they did before
   *  filePath: the downloaded file on disk
   *  downloadUrl: where the file came from, used to pick the right entry
   *  checksumsUrl: the published checksums file, empty when there is none
   *  platform: the platform the download was picked for
   */
  if (!checksumsUrl) {
    core.warning(
      `No checksums are published for ${downloadUrl}, skipping verification`,
    );
    return;
  }

  let checksums: Map<string, string>;
  try {
    const response = await fetch(checksumsUrl);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    checksums = parseChecksums(await response.text());
  } catch (error) {
    core.warning(
      `Unable to fetch checksums from ${checksumsUrl}, skipping verification: ${error}`,
    );
    return;
  }

  let fileName: string;
  try {
    fileName = path.posix.basename(new URL(downloadUrl).pathname);
  } catch {
    core.warning(
      `Could not derive a file name from ${downloadUrl}, skipping verification`,
    );
    return;
  }

  const expected = findChecksum(checksums, fileName, platform);

  if (!expected) {
    core.warning(
      `No checksum listed for ${fileName} in ${checksumsUrl}, skipping verification`,
    );
    return;
  }

  const actual = await sha256(filePath);

  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${fileName}: expected ${expected} but the download from ${downloadUrl} hashed to ${actual}. Refusing to install.`,
    );
  }

  core.info(`Verified the sha256 checksum of ${fileName}`);
}

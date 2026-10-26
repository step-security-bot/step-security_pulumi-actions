import * as core from '@actions/core';
import { context, getOctokit } from '@actions/github';
import dedent from 'dedent';
import { invariant } from 'ts-invariant';
import { Config } from '../config';
import { stripAnsiControlCodes } from './utils';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

// Longest entity emitted by escapeHtml is `&amp;`; allow a little slack.
const MAX_ENTITY_LENGTH = 6;

function escapeHtml(text: string): string {
  /**
   *  Escape the characters that would otherwise let Pulumi output close the
   *  surrounding <pre> block and render as markup in the PR comment
   *  text: string to escape
   *
   *  return the escaped string
   */
  return text.replace(/[&<>]/g, (char) => HTML_ESCAPES[char]);
}

function alignToEntityBoundary(
  text: string,
  index: number,
  trimFromFront: boolean,
): number {
  /**
   *  Move a cut point so it never lands inside an HTML entity, which would
   *  leave a fragment such as `&l` in the rendered comment
   *  text: escaped string that is about to be cut
   *  index: proposed cut point, the first character kept when trimming from
   *         the front and the first character dropped otherwise
   *  trimFromFront: whether the cut keeps the tail rather than the head
   *
   *  return the adjusted cut point
   */
  const start = text.lastIndexOf('&', index);

  if (start === -1 || start >= index || index - start >= MAX_ENTITY_LENGTH) {
    return index;
  }

  const end = text.indexOf(';', start);

  if (trimFromFront) {
    // An entity opened before the cut and closes at or after it, so drop the
    // whole entity rather than keeping its tail.
    return end !== -1 && end >= index && end - start < MAX_ENTITY_LENGTH
      ? end + 1
      : index;
  }

  // An entity is still open at the cut, so drop it rather than keeping its head.
  return end === -1 || end >= index ? start : index;
}

function trimOutputByCharacters(
  message: string,
  maxLength: number,
  alwaysIncludeSummary: boolean,
): [string, boolean] {
  /**
   *  Trim message to maxLength
   *  message: string to trim
   *  maxLength: Maximum number of characters of final message
   *  alwaysIncludeSummary: if true, trim message from front (if trimming is needed), otherwise from end
   *
   *  return message and information if message was trimmed
   */
  let trimmed = false;

  // Check if message exceeds max characters
  if (message.length > maxLength) {

    // Trim input message by number of exceeded characters from front or back as configured
    const dif: number = message.length - maxLength;

    if (alwaysIncludeSummary) {
      message = message.substring(alignToEntityBoundary(message, dif, true));
    } else {
      const end = alignToEntityBoundary(message, message.length - dif, false);
      message = message.substring(0, end);
    }

    trimmed = true;
  }

  return [message, trimmed];
}

function isSafeLinkTarget(candidate: string): boolean {
  /**
   *  Checks that a string is safe to use as a Markdown link target. The link
   *  is built from Pulumi output, so it must not be able to close the link
   *  early or carry a scheme other than http(s)
   *  candidate: link target taken from the output
   *
   *  return true if the target is a well-formed http(s) URL
   */
  if (!candidate || /[\s<>()[\]'"`\\]/.test(candidate)) {
    return false;
  }

  try {
    const { protocol } = new URL(candidate);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function extractViewLiveLink(output: string) {
  /**
   *  Extracts the Pulumi preview link from the output
   *  output: pulumi preview output
   *
   *  return link to the Pulumi preview, or an empty string if the output does
   *  not contain one that is safe to render
   */
  const lines = output.split('\n');
  const linkLine = lines.find((line) => line.includes('View Live:'));
  if (!linkLine) {
    return '';
  }
  const candidate = (linkLine.split('View Live: ')[1] ?? '').trim();
  return isSafeLinkTarget(candidate) ? candidate : '';
}

export async function handlePullRequestMessage(
  config: Config,
  projectName: string,
  output: string,
): Promise<void> {
  const {
    githubToken,
    command,
    stackName,
    editCommentOnPr,
    alwaysIncludeSummary,
  } = config;

  // Remove ANSI symbols from output because they are not supported in GitHub PR message
  output = stripAnsiControlCodes(output);

  // GitHub limits PR comment characters to 65_535, use lower max to keep buffer for variable values
  const MAX_CHARACTER_COMMENT = 64_000;

  const heading = `#### :tropical_drink: \`${command}\` on ${projectName}/${stackName}`;

  const summary = '<summary>Pulumi report</summary>';

  const viewLiveLink = extractViewLiveLink(output);

  // Escape before trimming so the escaped body still fits the character budget
  const [message, trimmed]: [string, boolean] = trimOutputByCharacters(escapeHtml(output), MAX_CHARACTER_COMMENT, alwaysIncludeSummary);

  const body = dedent`
    ${heading}

    <details>
    ${summary}
    ${viewLiveLink ? `\n[View in Pulumi Cloud](${viewLiveLink})\n` : ''}
    ${trimmed && alwaysIncludeSummary
      ? ':warning: **Warn**: The output was too long and trimmed from the front.'
      : ''
    }
    <pre>
    ${message}
    </pre>
    ${trimmed && !alwaysIncludeSummary
      ? ':warning: **Warn**: The output was too long and trimmed.'
      : ''
    }
    </details>
  `;

  const { payload, repo } = context;
  // Assumes PR numbers are always positive.
  const nr = config.commentOnPrNumber || payload.pull_request?.number;
  invariant(nr, 'Missing pull request event data.');

  const octokit = getOctokit(githubToken);

  try {
    if (editCommentOnPr) {
      const { data: comments } = await octokit.rest.issues.listComments({
        ...repo,
        issue_number: nr,
      });
      const comment = comments.find((comment) =>
        comment.body.startsWith(heading) && comment.body.includes(summary),
      );

      // If comment exists, update it.
      if (comment) {
        await octokit.rest.issues.updateComment({
          ...repo,
          comment_id: comment.id,
          body,
        });
        return;
      }
    }
  } catch {
    core.warning(
      'Not able to edit comment, defaulting to creating a new comment.',
    );
  }

  await octokit.rest.issues.createComment({
    ...repo,
    issue_number: nr,
    body,
  });
}

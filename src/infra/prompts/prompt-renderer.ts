import type {
  GitHubComment,
  GitHubSourceContext,
  LinkedRefEntry,
  LinkedRefs,
} from "../../domain/github.js";
import type {
  ContextKey,
  PromptFragment,
} from "../../strategies/types.js";
import type { PromptFragmentCache } from "./prompt-fragment-loader.js";

export interface PromptRendererOptions {
  fragments: PromptFragmentCache;
}

export class PromptRenderer {
  private readonly fragments: PromptFragmentCache;

  constructor(options: PromptRendererOptions) {
    this.fragments = options.fragments;
  }

  render(
    fragments: readonly PromptFragment[],
    context: GitHubSourceContext,
  ): string {
    return fragments
      .map((fragment) => this.renderOne(fragment, context))
      .filter((piece) => piece.length > 0)
      .join("\n\n");
  }

  private renderOne(
    fragment: PromptFragment,
    context: GitHubSourceContext,
  ): string {
    if (fragment.kind === "literal") {
      return fragment.text;
    }
    if (fragment.kind === "user") {
      return fragment.text.length > 0
        ? `User additional instructions:\n${fragment.text}`
        : "";
    }
    if (fragment.kind === "file") {
      const content = this.fragments.get(fragment.path);
      if (content === undefined) {
        throw new Error(`Unknown prompt fragment: '${fragment.path}'`);
      }
      return content;
    }
    return renderContextBlock(fragment.key, context);
  }
}

function renderContextBlock(
  key: ContextKey,
  context: GitHubSourceContext,
): string {
  switch (key) {
    case "issue-body":
      return context.kind === "issue" ? renderBodyBlock(context.body) : "";
    case "issue-comments":
      return context.kind === "issue"
        ? renderCommentsBlock(context.comments)
        : "";
    case "pr-body":
      return context.kind === "pull_request"
        ? renderBodyBlock(context.body)
        : "";
    case "pr-comments":
      return context.kind === "pull_request"
        ? renderCommentsBlock(context.comments)
        : "";
    case "pr-diff":
      return context.kind === "pull_request" ? `Diff:\n${context.diff}` : "";
    case "pr-base-head":
      return context.kind === "pull_request"
        ? `Base: ${context.baseRef}\nHead: ${context.headRef}`
        : "";
    case "linked-refs":
      return renderLinkedRefsBlock(context.linkedRefs, context.kind);
  }
}

function renderBodyBlock(body: string): string {
  return `Body:\n${body}`;
}

function renderCommentsBlock(comments: GitHubComment[]): string {
  const lines =
    comments.length > 0
      ? comments.map((c) => `- ${c.author}: ${c.body}`)
      : ["- none"];
  return ["Comments:", ...lines].join("\n");
}

function renderLinkedRefsBlock(
  linkedRefs: LinkedRefs,
  sourceKind: "issue" | "pull_request",
): string {
  const closesHeader =
    sourceKind === "issue"
      ? "Linked PRs (closes):"
      : "Linked Issues (closes):";

  const closesLines =
    linkedRefs.closes.length > 0
      ? linkedRefs.closes.map(formatLinkedRefEntry)
      : ["- none"];

  const sections: string[] = [[closesHeader, ...closesLines].join("\n")];

  if (linkedRefs.bodyMentions.length > 0) {
    sections.push(
      [
        "Referenced (body mentions):",
        ...linkedRefs.bodyMentions.map(formatLinkedRefEntry),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function formatLinkedRefEntry(entry: LinkedRefEntry): string {
  const stateLabel =
    entry.kind === "pull_request" && entry.merged === true
      ? "merged"
      : entry.state;
  const kindLabel = entry.kind === "pull_request" ? "pr" : "issue";
  return `- ${kindLabel} #${entry.number} (${stateLabel}) — ${entry.title}`;
}

# Push — ChatGPT to Codex

Push adds a split button to completed ChatGPT responses in Chrome on Windows 11. It transfers the selected text, or the full response, into the Codex desktop composer.

<table>
  <tr>
    <td>
      <img width="714" height="649" alt="push"
        src="https://github.com/user-attachments/assets/b73ae10f-7385-44d1-8638-1572c67fa68a" />
    </td>
  </tr>
</table>

## Install

1. Install the [Codex desktop app](https://openai.com/codex/) and the [.NET 10 SDK for Windows](https://dotnet.microsoft.com/download/dotnet/10.0).
2. Open Chrome’s extension manager at `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**. Select this repository’s `extension` folder.
3. Copy Push’s 32-letter **ID** from its extension card. In PowerShell, from this repository, run

   ```powershell
   .\setup.ps1 -ExtensionId YOUR_EXTENSION_ID
   ```

4. Refresh your ChatGPT tabs. After updating the source, reload Push in Chrome and rerun setup if the native helper changed. Rerun setup with the new ID if Chrome assigns one after you move the unpacked folder.

Setup builds the helper, installs it under `%LOCALAPPDATA%PushToCodex`, and registers the exact extension ID under your Windows user account. Chrome starts the helper for each transfer.

## Use

- Click **Push** to target the Codex chat currently open on your desktop. Highlight text within the response first to transfer just that selection.
- Use the chevron to select **Start new chat** or enable **Automatically submit prompt**. The default leaves a draft for review. Both preferences are saved in Chrome.
- If Push reports **Check Codex before trying again**, inspect the composer and conversation before repeating the transfer.

## How it works

The Manifest V3 content script reads rendered assistant Markdown and ignores response controls. Chrome Native Messaging passes the prompt locally to a .NET Windows helper. The helper verifies the OpenAI desktop package and a unique composer using Windows UI Automation. For a new chat, it opens `codex://threads/new` and checks that the composer is empty before inserting. It uses Codex’s documented prefill for encoded URLs up to 1,800 characters. Active chats and longer new-chat prompts use a verified paste.

Automatic submission requires the helper to verify the exact composer text. Codex can render Markdown as rich text, which changes the accessibility value. If the helper can see a draft but cannot verify its exact text, Push shows **Review the draft in Codex** and leaves it for you to send.

Push stores only the two Chrome preferences and has no server. ChatGPT’s **Copy** button provides a user-facing clipboard action. Push reconstructs Markdown from visible content, so original spacing, citation markup, and interactive response elements may differ.

Codex’s rich-text composer ignored a direct UI Automation value write in testing. The helper verifies focus and uses a single paste, then checks the resulting draft through UI Automation. It snapshots the current Windows clipboard and restores it if the clipboard still belongs to Push. It excludes the temporary prompt from Windows clipboard history and sync. Clipboard formats that Push cannot snapshot block the transfer.

### Compatibility

The desktop selectors use the English names exposed by the Microsoft Store build inspected here. A different build, language, or composer mode may expose different controls. Push reports a failure if it cannot verify the window, composer, or focus. The native request envelope is capped at 1 MiB.

References [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Codex deep links](https://learn.chatgpt.com/docs/reference/commands#deep-links), and [Windows UI Automation](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview).

## Verify

From the repository root, with Node.js and Chrome installed, run

```powershell
dotnet build .\native\PushHost.csproj -c Release
node .\tests\check.mjs
```

The native build and the automated protocol, worker, and isolated Chrome fixture checks passed. They cover validation, missing-helper feedback, duplicate requests, Markdown and Unicode, partial selections, long text, keyboard navigation, saved preference loading, dynamic response mounting, and both themes.

The live Windows probe found the Codex composer. The helper refused a transfer into a busy active chat and returned **Codex not open** from a test session with no desktop window. Live inspection also found that Codex exposes its placeholder as an editable value. The draft guard now checks for the composer’s empty-state controls before treating that value as a placeholder.

The short new-chat prefill was verified visually in the installed Codex app. The unsent sample retained its heading, code block, and Unicode. The test also compared clipboard text before and after the corrected attempts and found it unchanged. Successful paste into an existing chat, longer desktop transfers, automatic submission, and the complete Chrome-to-desktop flow remain unverified.

For a live smoke test, start with “Please reply with PUSH OK. Do not modify files or run commands.” Try a selection and a full response, then repeat with a fenced code block and a longer answer. Check both destinations with submission off before testing submission on in a disposable chat. Confirm that a draft, busy Codex session, and multiple Codex windows block the transfer. Also check a minimized desktop window, Codex fully closed, and Chrome after a browser restart.

## Uninstall

Run `.\uninstall.ps1` from this repository and remove Push from Chrome’s extension manager.

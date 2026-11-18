using System.ComponentModel;
using System.Diagnostics;
using System.Windows.Automation;

namespace PushToCodex;

internal static class DesktopTransfer
{
    private const string ExistingComposer = "Work with Codex";
    private const string NewComposer = "Do anything";
    private const string NewChatLink = "codex://threads/new";
    private static readonly string[] BusyNames = ["Stop", "Queue", "Steer", "Resume"];

    internal static string Run(Transfer request)
    {
        nint[] windows = Windows.CodexWindows();
        if (windows.Length > 1) return "ambiguous";
        nint hwnd = windows.FirstOrDefault();

        if (request.NewChat)
        {
            // The prompt-bearing deep link can replace a home draft on the installed build.
            // Open a blank chat and inspect the destination before introducing any text.
            if (!OpenLink(NewChatLink)) return "codex_unavailable";
            Windows.WaitUntil(() => (windows = Windows.CodexWindows()).Length != 0, 8_000);
            if (windows.Length > 1) return "ambiguous";
            if (windows.Length == 0) return "codex_unavailable";
            hwnd = windows[0];
        }
        else if (hwnd == 0) return "not_open";

        Windows.Restore(hwnd);
        string expectedLabel = request.NewChat ? NewComposer : ExistingComposer;
        AutomationElement? editor = null;
        AutomationElement window = AutomationElement.FromHandle(hwnd);
        Windows.WaitUntil(() => (editor = FindEditor(window, expectedLabel)) is not null,
            request.NewChat ? 3_000 : 1_200);

        if (editor is null) return request.NewChat ? "no_composer" : "no_chat";
        // The installed Codex build exposes the prompt and its action in the same raw UIA group.
        AutomationElement? composer = TreeWalker.RawViewWalker.GetParent(editor);
        if (composer?.Current.ControlType != ControlType.Group)
            return request.NewChat ? "no_composer" : "no_chat";
        if (HasBusyControl(composer)) return "busy";
        if (!editor.TryGetCurrentPattern(ValuePattern.Pattern, out var valueObject) ||
            valueObject is not ValuePattern value || value.Current.IsReadOnly)
            return "unsupported_editor";
        if (!IsEmpty(composer, editor, value)) return "draft";

        if (!Windows.HasUniqueTarget(hwnd)) return "ambiguous";
        if (!Windows.Activate(hwnd)) return "focus";
        editor.SetFocus();
        if (!Windows.WaitUntil(() => IsSameFocusedEditor(hwnd, window, editor, expectedLabel), 650)) return "focus";
        if (HasBusyControl(composer)) return "busy";
        if (!IsEmpty(composer, editor, value)) return "draft";
        if (!Windows.ForegroundIs(hwnd) || !editor.Current.HasKeyboardFocus) return "focus";

        string prompt = Normalize(request.Prompt);
        if (request.NewChat && prompt.Length < 1_800)
        {
            // Codex's own prefill is preferable for a short new-chat draft after the
            // destination has been verified empty. The encoded URL must also fit.
            string link = "codex://new?prompt=" + Uri.EscapeDataString(prompt);
            if (link.Length <= 1_800)
            {
                if (!IsSameFocusedEditor(hwnd, window, editor, expectedLabel) ||
                    HasBusyControl(composer) || !IsEmpty(composer, editor, value))
                    return "focus";
                return PrefillNew(hwnd, window, link, prompt, request.Submit);
            }
        }

        // The Codex rich-text editor reports writable UIA Value support but ignored SetValue in testing.
        string insertion = ClipboardPaste.Insert(prompt,
            () => IsSameFocusedEditor(hwnd, window, editor, expectedLabel) &&
                !HasBusyControl(composer) && IsEmpty(composer, editor, value) &&
                Windows.ForegroundIs(hwnd) && editor.Current.HasKeyboardFocus,
            () => ContentMatches(value, prompt) && FindButton(composer, "Send")?.Current.IsEnabled == true);
        if (insertion == "unknown_outcome" && IsSameFocusedEditor(hwnd, window, editor, expectedLabel) &&
            FindButton(composer, "Send")?.Current.IsEnabled == true)
            return "review_draft";
        if (insertion != "inserted") return insertion;
        if (!IsSameFocusedEditor(hwnd, window, editor, expectedLabel)) return "unknown_outcome";
        return Finish(hwnd, window, editor, composer, value, prompt, request.NewChat, request.Submit);
    }

    private static string PrefillNew(nint hwnd, AutomationElement window, string link, string prompt, bool submit)
    {
        if (!OpenLink(link)) return "codex_unavailable";
        AutomationElement? editor = null;
        AutomationElement? composer = null;
        ValuePattern? value = null;
        bool draftVisible = false;
        bool confirmed = Windows.WaitUntil(() =>
        {
            draftVisible = false;
            editor = FindEditor(window, NewComposer);
            if (editor is null || !IsSameFocusedEditor(hwnd, window, editor, NewComposer) ||
                !editor.TryGetCurrentPattern(ValuePattern.Pattern, out var valueObject) ||
                valueObject is not ValuePattern currentValue) return false;
            composer = TreeWalker.RawViewWalker.GetParent(editor);
            value = currentValue;
            draftVisible = composer?.Current.ControlType == ControlType.Group &&
                !string.IsNullOrWhiteSpace(value.Current.Value) &&
                FindButton(composer, "Send")?.Current.IsEnabled == true;
            return draftVisible && ContentMatches(value, prompt);
        }, 2_500);
        if (!confirmed) return draftVisible ? "review_draft" : "unknown_outcome";
        return Finish(hwnd, window, editor!, composer!, value!, prompt, newChat: true, submit);
    }

    private static string Finish(nint hwnd, AutomationElement window, AutomationElement editor,
        AutomationElement composer, ValuePattern value, string prompt, bool newChat, bool submit)
    {
        if (!submit) return "inserted";
        string expectedLabel = newChat ? NewComposer : ExistingComposer;
        var send = FindButton(composer, "Send");
        if (send is null || !send.Current.IsEnabled ||
            !send.TryGetCurrentPattern(InvokePattern.Pattern, out var action) ||
            HasBusyControl(composer) || !IsSameFocusedEditor(hwnd, window, editor, expectedLabel) ||
            !ContentMatches(value, prompt))
            return "inserted_review";

        // Invoking the verified Send control avoids key events and Codex's configurable Enter behavior.
        ((InvokePattern)action).Invoke();
        bool submitted = Windows.WaitUntil(() =>
        {
            var current = FindEditor(window, ExistingComposer);
            if (current is null || !Windows.ForegroundIs(hwnd) ||
                TreeWalker.RawViewWalker.GetParent(current) is not { } currentComposer ||
                FindButton(currentComposer, "Stop") is null) return false;
            if (newChat) return FindEditor(window, NewComposer) is null;
            return Automation.Compare(editor, current) &&
                (value.Current.Value.Length == 0 || Normalize(value.Current.Value) == expectedLabel + "\n");
        }, 2_200);
        return submitted ? "submitted" : "unknown_outcome";
    }

    private static bool OpenLink(string link)
    {
        try
        {
            using var launched = Process.Start(new ProcessStartInfo(link) { UseShellExecute = true });
            return true;
        }
        catch (Win32Exception) { return false; }
    }

    private static AutomationElement? FindEditor(AutomationElement window, string label) =>
        FindVisible(window, ControlType.Edit, label) is [var editor] &&
        editor.Current.IsEnabled && editor.Current.IsKeyboardFocusable ? editor : null;

    private static AutomationElement? FindButton(AutomationElement window, string label) =>
        FindVisible(window, ControlType.Button, label) is [var button] ? button : null;

    private static bool HasBusyControl(AutomationElement composer) =>
        BusyNames.Any(label => FindVisible(composer, ControlType.Button, label).Length > 0);

    private static bool IsEmpty(AutomationElement composer, AutomationElement editor, ValuePattern value)
    {
        var send = FindButton(composer, "Send");
        if (send?.Current.IsEnabled == true) return false;

        string text = Normalize(value.Current.Value);
        if (text.Length > 0)
        {
            // Codex exposes placeholder text in the editable value. A draft that equals the
            // placeholder still has a Send control instead of the empty composer's voice action.
            if (text != editor.Current.Name + "\n" || send is not null ||
                FindButton(composer, "Start new voice chat") is null ||
                !FindVisible(editor, ControlType.Text, editor.Current.Name).Any())
                return false;

            var trailingBreak = new PropertyCondition(AutomationElement.ClassNameProperty, "ProseMirror-trailingBreak");
            if (editor.FindFirst(TreeScope.Descendants, trailingBreak) is null) return false;
        }

        // Treat attachment-only drafts as occupied when Codex exposes the remove control.
        var buttons = composer.FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
        return !buttons.Cast<AutomationElement>().Any(button => !button.Current.IsOffscreen &&
            (button.Current.Name.StartsWith("Remove attachment", StringComparison.OrdinalIgnoreCase) ||
             button.Current.Name.StartsWith("Remove file", StringComparison.OrdinalIgnoreCase)));
    }

    private static AutomationElement[] FindVisible(AutomationElement window, ControlType kind, string label)
    {
        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.ControlTypeProperty, kind),
            new PropertyCondition(AutomationElement.NameProperty, label),
            new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
        return window.FindAll(TreeScope.Descendants, condition).Cast<AutomationElement>().ToArray();
    }

    private static bool IsSameFocusedEditor(nint hwnd, AutomationElement window, AutomationElement editor, string label) =>
        Windows.HasUniqueTarget(hwnd) && FindEditor(window, label) is { } current &&
        Automation.Compare(current, editor) && editor.Current.HasKeyboardFocus && Windows.ForegroundIs(hwnd);

    private static bool ContentMatches(ValuePattern value, string prompt)
    {
        string actual = Normalize(value.Current.Value);
        return actual == prompt || actual.EndsWith('\n') && actual[..^1] == prompt;
    }
    private static string Normalize(string value) => value.Replace("\r\n", "\n").Replace('\r', '\n');
}

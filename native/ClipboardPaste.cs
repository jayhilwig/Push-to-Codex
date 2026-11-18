using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Interop;

namespace PushToCodex;

internal static class ClipboardPaste
{
    private const uint UnicodeText = 13;
    private const uint Bitmap = 2;
    private const uint Palette = 9;
    private const int ClipboardBudget = 64 * 1024 * 1024;

    internal static string Insert(string prompt, Func<bool> canPaste, Func<bool> draftConfirmed)
    {
        using var owner = new HwndSource(new HwndSourceParameters("Push clipboard owner")
        {
            ParentWindow = new nint(-3) // HWND_MESSAGE
        });
        uint exclusion = RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing");
        using var privacy = ClipboardItem.FromBytes(exclusion, new byte[4]);
        using var text = ClipboardItem.FromBytes(UnicodeText, Encoding.Unicode.GetBytes(prompt + '\0'));
        if (exclusion == 0 || privacy.Handle == 0 || text.Handle == 0)
            return "clipboard_unavailable";

        var previous = new List<ClipboardItem>();
        uint version = 0;
        bool ownsClipboard = false;
        try
        {
            if (!Windows.WaitUntil(() => OpenClipboard(owner.Handle), 500)) return "clipboard_unavailable";
            try
            {
                if (!TrySnapshot(previous)) return "clipboard_format";
                if (!EmptyClipboard()) return "clipboard_unavailable";
                ownsClipboard = true;
                if (!privacy.Publish() || !text.Publish())
                {
                    Restore(previous);
                    ownsClipboard = false;
                    return "clipboard_unavailable";
                }
            }
            finally { CloseClipboard(); }

            // Windows commits a clipboard update when the writer closes it.
            version = GetClipboardSequenceNumber();
            bool OwnsCurrentClipboard() =>
                GetClipboardOwner() == owner.Handle && GetClipboardSequenceNumber() == version;
            if (!OwnsCurrentClipboard()) return "clipboard_unavailable";
            if (!Windows.PasteIntoForeground(() => canPaste() && OwnsCurrentClipboard())) return "focus";

            return Windows.WaitUntil(draftConfirmed, 2_500) ? "inserted" : "unknown_outcome";
        }
        finally
        {
            if (ownsClipboard && Windows.WaitUntil(() => OpenClipboard(owner.Handle), 650))
            {
                try
                {
                    // The user or another app may have copied something while Codex was processing the paste.
                    if (GetClipboardOwner() == owner.Handle && GetClipboardSequenceNumber() == version)
                        Restore(previous);
                }
                finally { CloseClipboard(); }
            }

            foreach (var item in previous) item.Dispose();
        }
    }

    private static bool TrySnapshot(List<ClipboardItem> previous)
    {
        ulong size = 0;
        for (uint format = EnumClipboardFormats(0); format > 0; format = EnumClipboardFormats(format))
        {
            // OLE's process-local records describe the old clipboard owner. Restore the
            // actual data formats, which apps can read directly from the clipboard.
            if (format >= 0xC000)
            {
                var name = new StringBuilder(128);
                GetClipboardFormatName(format, name, name.Capacity);
                if (name.ToString() is "Ole Private Data" or "DataObject") continue;
            }
            if (format is 3 or 14 || format is >= 0x0200 and < 0x0400) return false;

            nint original = GetClipboardData(format);
            if (original == 0) return false;
            if (format is not (Bitmap or Palette))
            {
                ulong bytes = GlobalSize(original).ToUInt64();
                if (bytes == 0 || bytes > ClipboardBudget || (size += bytes) > ClipboardBudget) return false;
            }
            nint duplicate = OleDuplicateData(original, (ushort)format, 0);
            if (duplicate == 0) return false;
            previous.Add(new ClipboardItem(format, duplicate));
        }
        return true;
    }

    private static void Restore(List<ClipboardItem> previous)
    {
        if (!EmptyClipboard()) return;
        foreach (var item in previous) item.Publish();
    }

    private sealed class ClipboardItem(uint format, nint handle) : IDisposable
    {
        internal nint Handle { get; private set; } = handle;

        internal static ClipboardItem FromBytes(uint format, byte[] bytes)
        {
            nint handle = GlobalAlloc(0x0002 /* GMEM_MOVEABLE */, (nuint)bytes.Length);
            if (handle != 0)
            {
                nint pointer = GlobalLock(handle);
                if (pointer != 0)
                {
                    Marshal.Copy(bytes, 0, pointer, bytes.Length);
                    GlobalUnlock(handle);
                }
                else
                {
                    GlobalFree(handle);
                    handle = 0;
                }
            }
            return new ClipboardItem(format, handle);
        }

        internal bool Publish()
        {
            if (SetClipboardData(format, Handle) == 0) return false;
            Handle = 0; // Windows owns it after SetClipboardData.
            return true;
        }

        public void Dispose()
        {
            if (Handle == 0) return;
            if (format is Bitmap or Palette) DeleteObject(Handle);
            else GlobalFree(Handle);
            Handle = 0;
        }
    }

    [DllImport("user32.dll")] private static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll")] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern nint GetClipboardOwner();
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] private static extern uint EnumClipboardFormats(uint format);
    [DllImport("user32.dll")] private static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll")] private static extern nint SetClipboardData(uint format, nint data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterClipboardFormat(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClipboardFormatName(uint format, StringBuilder name, int length);
    [DllImport("kernel32.dll")] private static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll")] private static extern nuint GlobalSize(nint memory);
    [DllImport("kernel32.dll")] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll")] private static extern nint GlobalFree(nint memory);
    [DllImport("ole32.dll")] private static extern nint OleDuplicateData(nint source, ushort format, uint flags);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(nint item);
}

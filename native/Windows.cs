using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace PushToCodex;

internal static class Windows
{
    private const string CodexPackageFamily = "OpenAI.Codex_2p2nqsd0c76g0";

    internal static nint[] CodexWindows()
    {
        var windows = new List<nint>();
        EnumWindows((hwnd, _) =>
        {
            if (IsWindowVisible(hwnd) && GetWindow(hwnd, 4 /* GW_OWNER */) == 0 &&
                ClassName(hwnd) == "Chrome_WidgetWin_1" &&
                IsCodexWindow(hwnd))
                windows.Add(hwnd);

            return true;
        }, 0);
        return windows.ToArray();
    }

    private static bool IsCodexWindow(nint hwnd)
    {
        GetWindowThreadProcessId(hwnd, out uint pid);
        using var process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (process.IsInvalid) return false;
        var package = new StringBuilder(256);
        int size = package.Capacity;
        return GetPackageFamilyName(process, ref size, package) == 0 &&
            string.Equals(package.ToString(), CodexPackageFamily, StringComparison.OrdinalIgnoreCase);
    }

    private static string ClassName(nint hwnd)
    {
        var name = new StringBuilder(128);
        GetClassName(hwnd, name, name.Capacity);
        return name.ToString();
    }

    internal static void Restore(nint hwnd)
    {
        if (IsIconic(hwnd)) ShowWindowAsync(hwnd, 9 /* SW_RESTORE */);
    }

    internal static bool Activate(nint hwnd)
    {
        if (ForegroundIs(hwnd)) return true;
        SetForegroundWindow(hwnd);
        return WaitUntil(() => ForegroundIs(hwnd), 900);
    }

    internal static bool ForegroundIs(nint hwnd) => !IsIconic(hwnd) && GetForegroundWindow() == hwnd;
    internal static bool HasUniqueTarget(nint hwnd) => CodexWindows() is [var only] && only == hwnd;

    internal static bool PasteIntoForeground(Func<bool> isVerified)
    {
        const ushort Control = 0x11;
        const ushort V = 0x56;
        const uint KeyUp = 2;
        int[] modifiers = [0x10, Control, 0x12, 0x5B, 0x5C]; // Shift, Ctrl, Alt, Win keys
        Input[] input = [Input.Key(Control), Input.Key(V), Input.Key(V, KeyUp), Input.Key(Control, KeyUp)];
        if (modifiers.Any(key => GetAsyncKeyState(key) < 0) || !isVerified()) return false;
        return SendInput((uint)input.Length, input, Marshal.SizeOf<Input>()) == input.Length;
    }

    internal static bool WaitUntil(Func<bool> condition, int milliseconds)
    {
        long deadline = Environment.TickCount64 + milliseconds;
        do
        {
            if (condition()) return true;
            Thread.Sleep(100);
        } while (Environment.TickCount64 < deadline);
        return false;
    }

    private delegate bool WindowCallback(nint hwnd, nint parameter);

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputData Data;

        internal static Input Key(ushort key, uint flags = 0) =>
            new() { Type = 1, Data = new() { Keyboard = new() { VirtualKey = key, Flags = flags } } };
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        [FieldOffset(0)] public MouseInput Mouse; // The largest member sets the native union size.
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort VirtualKey, ScanCode;
        public uint Flags, Time;
        public nuint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public nuint ExtraInfo;
    }

    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, nint parameter);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(nint hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(nint hwnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(nint hwnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(nint hwnd);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern uint SendInput(uint count, Input[] input, int size);
    [DllImport("user32.dll")] private static extern nint GetWindow(nint hwnd, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint hwnd, StringBuilder name, int length);

    [DllImport("kernel32.dll")] private static extern SafeProcessHandle OpenProcess(uint rights, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetPackageFamilyName(SafeProcessHandle process, ref int length, StringBuilder name);
}

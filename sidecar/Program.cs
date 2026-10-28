// Hardware sidecar for Lights Fan Action: exposes LibreHardwareMonitor sensors and fan controls
// over a loopback TCP socket (one JSON object per line). Every exit path hands the fans back to
// firmware control: client disconnect, "shutdown", parent exit, heartbeat timeout, Ctrl+C.
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;

string? token = null, portFile = null;
int parentPid = 0;
for (int i = 0; i < args.Length - 1; i++)
{
    switch (args[i])
    {
        case "--token": token = args[i + 1]; break;
        case "--port-file": portFile = args[i + 1]; break;
        case "--parent": parentPid = int.Parse(args[i + 1]); break;
    }
}
if (token is null || portFile is null)
{
    Console.Error.WriteLine("usage: lfa-hw --token T --port-file F [--parent PID]");
    return 2;
}

var hw = new Hardware();
AppDomain.CurrentDomain.ProcessExit += (_, _) => hw.ResetAll();
Console.CancelKeyPress += (_, e) => { hw.ResetAll(); e.Cancel = false; };

// If the app dies without saying goodbye, don't leave fans pinned at a software speed.
if (parentPid != 0)
{
    new Thread(() =>
    {
        try { Process.GetProcessById(parentPid).WaitForExit(); } catch { }
        hw.ResetAll();
        Environment.Exit(0);
    }) { IsBackground = true }.Start();
}
new Thread(() =>
{
    while (true)
    {
        Thread.Sleep(1000);
        if (hw.StaleFor() > TimeSpan.FromSeconds(8)) hw.ResetAll();
    }
}) { IsBackground = true }.Start();

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var tmp = portFile + ".tmp";
File.WriteAllText(tmp, ((IPEndPoint)listener.LocalEndpoint).Port.ToString());
File.Move(tmp, portFile, true);

var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
bool quit = false;
while (!quit)
{
    using var client = listener.AcceptTcpClient();
    client.ReceiveTimeout = 0;
    var stream = client.GetStream();
    var reader = new StreamReader(stream, new UTF8Encoding(false));
    var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
    try
    {
        var hello = reader.ReadLine();
        if (hello is null || JsonDocument.Parse(hello).RootElement.GetProperty("token").GetString() != token) continue;
        hw.Touch();
        writer.WriteLine(JsonSerializer.Serialize(new { ok = true, elevated = Hardware.IsAdmin }, json));
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            hw.Touch();
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            switch (root.GetProperty("cmd").GetString())
            {
                case "apply":
                    if (root.TryGetProperty("release", out var rel))
                        foreach (var r in rel.EnumerateArray())
                            hw.Release(r.GetString()!);
                    if (root.TryGetProperty("set", out var sets))
                        foreach (var s in sets.EnumerateArray())
                            hw.SetFan(s.GetProperty("id").GetString()!, s.GetProperty("pct").GetDouble());
                    writer.WriteLine(JsonSerializer.Serialize(hw.Snapshot(), json));
                    break;
                case "reset":
                    hw.ResetAll();
                    writer.WriteLine("{\"ok\":true}");
                    break;
                case "shutdown":
                    hw.ResetAll();
                    writer.WriteLine("{\"ok\":true}");
                    quit = true;
                    break;
                default:
                    writer.WriteLine("{\"error\":\"unknown command\"}");
                    break;
            }
            if (quit) break;
        }
    }
    catch (Exception e) when (e is IOException or JsonException or KeyNotFoundException or InvalidOperationException)
    {
        Console.Error.WriteLine(e.Message);
    }
    finally
    {
        hw.ResetAll(); // client gone: back to firmware control
    }
}
hw.Dispose();
return 0;

sealed class Hardware : IDisposable
{
    readonly Computer computer = new()
    {
        IsCpuEnabled = true,
        IsGpuEnabled = true,
        IsMotherboardEnabled = true,
        IsControllerEnabled = true,
        IsStorageEnabled = true,
    };
    readonly object gate = new();
    readonly HashSet<ISensor> overridden = new();
    Dictionary<string, ISensor> controls = new();
    long lastTouch = Stopwatch.GetTimestamp();
    long lastStorageUpdate;
    static readonly TimeSpan StorageEvery = TimeSpan.FromSeconds(30);

    public static bool IsAdmin =>
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    public Hardware() => computer.Open();
    public void Dispose() => computer.Close();

    public void Touch() => Interlocked.Exchange(ref lastTouch, Stopwatch.GetTimestamp());
    public TimeSpan StaleFor() => Stopwatch.GetElapsedTime(Interlocked.Read(ref lastTouch));

    static void UpdateAll(IHardware h)
    {
        h.Update();
        foreach (var s in h.SubHardware) UpdateAll(s);
    }
    static IEnumerable<ISensor> AllSensors(IHardware h) =>
        h.Sensors.Concat(h.SubHardware.SelectMany(AllSensors));

    static string Norm(string name) =>
        Regex.Replace(Regex.Replace(name, @"\bcontrol\b", "", RegexOptions.IgnoreCase), @"\s+", " ").Trim();

    public object Snapshot()
    {
        lock (gate)
        {
            foreach (var h in computer.Hardware)
            {
                // drive temperatures change slowly and every refresh is a SMART/NVMe query
                if (h.HardwareType == HardwareType.Storage && lastStorageUpdate != 0
                    && Stopwatch.GetElapsedTime(lastStorageUpdate) < StorageEvery) continue;
                UpdateAll(h);
                if (h.HardwareType == HardwareType.Storage) lastStorageUpdate = Stopwatch.GetTimestamp();
            }
            var all = computer.Hardware.SelectMany(AllSensors).ToList();

            var temps = all
                .Where(s => s.SensorType == SensorType.Temperature && s.Value is not null)
                .Select(s => new
                {
                    id = s.Identifier.ToString(),
                    name = $"{s.Hardware.Name} · {s.Name}",
                    value = Math.Round(s.Value!.Value, 1),
                    unit = "°C",
                })
                .ToList();

            var rpm = all.Where(s => s.SensorType == SensorType.Fan)
                .GroupBy(s => s.Hardware.Identifier + "|" + Norm(s.Name))
                .ToDictionary(g => g.Key, g => g.First());
            controls = new Dictionary<string, ISensor>();
            var fans = new List<object>();
            foreach (var c in all.Where(s => s.SensorType == SensorType.Control && s.Control is not null))
            {
                var id = c.Identifier.ToString();
                controls[id] = c;
                rpm.TryGetValue(c.Hardware.Identifier + "|" + Norm(c.Name), out var r);
                fans.Add(new
                {
                    id,
                    name = $"{c.Hardware.Name} · {Norm(c.Name)}",
                    rpm = (int)Math.Round(r?.Value ?? 0),
                    pct = (int)Math.Round(c.Value ?? 0),
                });
            }
            return new { sensors = temps, fans };
        }
    }

    public void SetFan(string id, double pct)
    {
        lock (gate)
        {
            if (!controls.TryGetValue(id, out var s) || s.Control is null) return;
            // a stalled pump can cook a CPU in seconds, so it never goes below half speed
            var floor = Regex.IsMatch(s.Name + " " + s.Hardware.Name, "pump|aio|water|liquid", RegexOptions.IgnoreCase) ? 50 : 0;
            s.Control.SetSoftware((float)Math.Clamp(pct, floor, 100));
            overridden.Add(s);
        }
    }

    /** Hands one control back to the firmware. */
    public void Release(string id)
    {
        lock (gate)
        {
            if (!controls.TryGetValue(id, out var s) || s.Control is null) return;
            try { s.Control.SetDefault(); } catch { /* ignore */ }
            overridden.Remove(s);
        }
    }

    public void ResetAll()
    {
        lock (gate)
        {
            foreach (var s in overridden)
            {
                try { s.Control?.SetDefault(); } catch { /* keep resetting the rest */ }
            }
            overridden.Clear();
        }
    }
}

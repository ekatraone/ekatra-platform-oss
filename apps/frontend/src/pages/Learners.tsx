/**
 * Learners — Operator Console
 *
 * Three actions:
 * 1. Add a single learner (name + phone + optional course)
 * 2. CSV bulk upload (phone, name rows → bulk-enroll)
 * 3. Per-learner side panel: FSM state, last 20 messages, Reset FSM, Change course
 */

import { useEffect, useRef, useState } from "react";
import Sidebar from "@/components/dashboard/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/use-toast";
import { apiClient } from "@/services/apiClient";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Loader2, UserPlus, Upload, RefreshCw, Search } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface Learner {
  id: string;
  name: string;
  phone: string;
  language: string;
  status: string;
  created_at: string;
  enrollments?: any[];
}

interface Course {
  id: string;
  title: string;
  status: string;
}

interface LearnerMessage {
  id: string;
  direction: "inbound" | "outbound";
  message_type: string;
  content: string;
  created_at: string;
  status?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseCSV(text: string): { phone: string; name?: string }[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [phone, name] = line.split(",").map((s) => s.trim());
      return { phone, name: name || undefined };
    })
    .filter((r) => /^\+?\d{7,15}$/.test(r.phone.replace(/\s/g, "")));
}

function fsmStateBadgeColor(state: string) {
  const map: Record<string, string> = {
    idle: "bg-gray-100 text-gray-700",
    topic_input: "bg-blue-100 text-blue-700",
    goal_input: "bg-blue-100 text-blue-700",
    confirming: "bg-yellow-100 text-yellow-700",
    generating: "bg-orange-100 text-orange-700",
    learning: "bg-green-100 text-green-700",
    doubt: "bg-purple-100 text-purple-700",
    review_flashcard: "bg-indigo-100 text-indigo-700",
    complete: "bg-emerald-100 text-emerald-700",
  };
  return map[state] || "bg-gray-100 text-gray-700";
}

// ── Main Component ─────────────────────────────────────────────────────────

const Learners = () => {
  const { toast } = useToast();

  // ── Data state ──────────────────────────────────────────────────────────
  const [learners, setLearners] = useState<Learner[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // ── Add single learner dialog ────────────────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [addName, setAddName] = useState("");
  const [addCourse, setAddCourse] = useState<string>("none");
  const [addSaving, setAddSaving] = useState(false);

  // ── CSV bulk upload dialog ──────────────────────────────────────────────
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvCourse, setCsvCourse] = useState<string>("none");
  const [csvRows, setCsvRows] = useState<{ phone: string; name?: string }[]>([]);
  const [csvFilename, setCsvFilename] = useState("");
  const [csvUploading, setCsvUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Learner detail side panel ───────────────────────────────────────────
  const [selected, setSelected] = useState<Learner | null>(null);
  const [fsmState, setFsmState] = useState<any>(null);
  const [messages, setMessages] = useState<LearnerMessage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [enrollCourse, setEnrollCourse] = useState<string>("none");
  const [enrolling, setEnrolling] = useState(false);

  // ── Fetch ────────────────────────────────────────────────────────────────

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [lr, cr] = await Promise.all([
        apiClient.getLearners() as Promise<any>,
        apiClient.getCourses({ status: "published" }) as Promise<any>,
      ]);
      setLearners(lr?.data || []);
      setCourses(cr?.data || []);
    } catch (err: any) {
      toast({ title: "Failed to load", description: err.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(); }, []);

  // ── Add single learner ──────────────────────────────────────────────────

  const handleAdd = async () => {
    if (!addPhone.trim()) return;
    setAddSaving(true);
    try {
      const res = await apiClient.createLearner({ phone: addPhone.trim(), name: addName.trim() || undefined }) as any;
      const learnerId = res?.data?.id;
      if (learnerId && addCourse !== "none") {
        await apiClient.enrollLearner(learnerId, addCourse);
      }
      toast({ title: "Learner added", description: `${addPhone} added successfully.` });
      setAddOpen(false);
      setAddPhone(""); setAddName(""); setAddCourse("none");
      fetchAll();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setAddSaving(false);
    }
  };

  // ── CSV upload ──────────────────────────────────────────────────────────

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvFilename(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCSV(text);
      setCsvRows(rows);
    };
    reader.readAsText(file);
  };

  const handleBulkUpload = async () => {
    if (csvRows.length === 0 || csvCourse === "none") return;
    setCsvUploading(true);
    try {
      const res = await apiClient.bulkEnroll({
        waIds: csvRows.map((r) => r.phone),
        courseId: csvCourse,
        sendWelcome: true,
      }) as any;
      toast({
        title: "Bulk enroll complete",
        description: `${res?.enrolled ?? 0}/${res?.total ?? csvRows.length} learners enrolled.`,
      });
      setCsvOpen(false);
      setCsvRows([]); setCsvFilename(""); setCsvCourse("none");
      if (fileRef.current) fileRef.current.value = "";
      fetchAll();
    } catch (err: any) {
      toast({ title: "Bulk upload failed", description: err.message, variant: "destructive" });
    } finally {
      setCsvUploading(false);
    }
  };

  // ── Learner detail panel ────────────────────────────────────────────────

  const openDetail = async (learner: Learner) => {
    setSelected(learner);
    setFsmState(null);
    setMessages([]);
    setDetailLoading(true);
    try {
      const [stateRes, msgRes] = await Promise.all([
        apiClient.getLearnerState(learner.id) as Promise<any>,
        apiClient.getLearnerMessages(learner.id, 20) as Promise<any>,
      ]);
      setFsmState(stateRes?.data?.fsm ?? null);
      setMessages(msgRes?.data || []);
    } catch (err: any) {
      toast({ title: "Failed to load learner detail", description: err.message, variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  };

  const handleReset = async (deleteHistory = false) => {
    if (!selected) return;
    setResetting(true);
    try {
      await apiClient.resetLearnerFSM(selected.id, deleteHistory);
      toast({ title: deleteHistory ? "Full reset done" : "FSM reset to idle" });
      // Refresh state
      const stateRes = await apiClient.getLearnerState(selected.id) as any;
      setFsmState(stateRes?.data?.fsm ?? null);
    } catch (err: any) {
      toast({ title: "Reset failed", description: err.message, variant: "destructive" });
    } finally {
      setResetting(false);
    }
  };

  const handleEnroll = async () => {
    if (!selected || enrollCourse === "none") return;
    setEnrolling(true);
    try {
      await apiClient.enrollLearner(selected.id, enrollCourse);
      toast({ title: "Enrolled", description: `${selected.name || selected.phone} enrolled in course.` });
      setEnrollCourse("none");
      fetchAll();
    } catch (err: any) {
      toast({ title: "Enroll failed", description: err.message, variant: "destructive" });
    } finally {
      setEnrolling(false);
    }
  };

  // ── Filtered learners ───────────────────────────────────────────────────

  const filtered = learners.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (l.name || "").toLowerCase().includes(q) ||
      l.phone.includes(q)
    );
  });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <div className="container mx-auto py-6 px-4 md:px-6">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-2xl font-bold">Learners</h1>
              <p className="text-muted-foreground">Add learners, enroll in courses, fix stuck conversations</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCsvOpen(true)}>
                <Upload className="h-4 w-4 mr-2" /> Bulk CSV
              </Button>
              <Button onClick={() => setAddOpen(true)}>
                <UserPlus className="h-4 w-4 mr-2" /> Add Learner
              </Button>
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="Search by name or phone…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Learner list */}
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center">No learners found.</p>
          ) : (
            <div className="border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Name</th>
                    <th className="text-left px-4 py-3 font-medium">Phone</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Joined</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.map((learner) => (
                    <tr key={learner.id} className="hover:bg-muted/30 cursor-pointer" onClick={() => openDetail(learner)}>
                      <td className="px-4 py-3 font-medium">{learner.name || "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground">{learner.phone}</td>
                      <td className="px-4 py-3">
                        <Badge variant={learner.status === "active" ? "default" : "secondary"}>
                          {learner.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {learner.created_at?.split("T")[0] || "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); openDetail(learner); }}>
                          View
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* ── Add Single Learner Dialog ─────────────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Learner</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="add-phone">WhatsApp number <span className="text-destructive">*</span></Label>
              <Input
                id="add-phone"
                placeholder="+91XXXXXXXXXX"
                value={addPhone}
                onChange={(e) => setAddPhone(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="add-name">Name (optional)</Label>
              <Input
                id="add-name"
                placeholder="Priya"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Enroll in course (optional)</Label>
              <Select value={addCourse} onValueChange={setAddCourse}>
                <SelectTrigger><SelectValue placeholder="Select course…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={!addPhone.trim() || addSaving}>
              {addSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Learner
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── CSV Bulk Upload Dialog ────────────────────────────────────────── */}
      <Dialog open={csvOpen} onOpenChange={setCsvOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bulk Enroll via CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              CSV format: one learner per line — <code className="bg-muted px-1 rounded">phone,name</code> (name optional).
              Phone must be in international format, e.g. <code className="bg-muted px-1 rounded">+919876543210</code>.
            </p>
            <div className="space-y-1">
              <Label>CSV file <span className="text-destructive">*</span></Label>
              <Input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFileChange} />
              {csvRows.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  ✓ {csvRows.length} valid row{csvRows.length !== 1 ? "s" : ""} parsed
                  {csvFilename ? ` from "${csvFilename}"` : ""}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Enroll in course <span className="text-destructive">*</span></Label>
              <Select value={csvCourse} onValueChange={setCsvCourse}>
                <SelectTrigger><SelectValue placeholder="Select course…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Select a course…</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCsvOpen(false)}>Cancel</Button>
            <Button
              onClick={handleBulkUpload}
              disabled={csvRows.length === 0 || csvCourse === "none" || csvUploading}
            >
              {csvUploading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Enroll {csvRows.length > 0 ? `${csvRows.length} Learner${csvRows.length !== 1 ? "s" : ""}` : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Learner Detail Side Panel ─────────────────────────────────────── */}
      <Sheet open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <SheetContent className="w-[420px] sm:w-[540px] flex flex-col gap-0 p-0">
          {selected && (
            <>
              <SheetHeader className="px-6 py-4 border-b">
                <SheetTitle>{selected.name || selected.phone}</SheetTitle>
                <SheetDescription className="font-mono text-xs">{selected.phone}</SheetDescription>
              </SheetHeader>

              <ScrollArea className="flex-1">
                <div className="px-6 py-4 space-y-6">
                  {detailLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      {/* FSM State */}
                      <section>
                        <h3 className="text-sm font-semibold mb-2">Conversation State</h3>
                        {fsmState ? (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-medium px-2 py-1 rounded-full ${fsmStateBadgeColor(fsmState.state)}`}>
                                {fsmState.state}
                              </span>
                              <span className="text-xs text-muted-foreground">v{fsmState.version}</span>
                            </div>
                            {fsmState.data?.topic && (
                              <p className="text-sm text-muted-foreground">Topic: <strong>{fsmState.data.topic}</strong></p>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-muted-foreground">No FSM state found.</p>
                        )}

                        {/* Reset buttons */}
                        <div className="flex gap-2 mt-3">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleReset(false)}
                            disabled={resetting}
                          >
                            {resetting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <RefreshCw className="h-3 w-3 mr-1" />}
                            Reset FSM
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleReset(true)}
                            disabled={resetting}
                          >
                            Full Reset
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          <strong>Reset FSM</strong> returns to idle. <strong>Full Reset</strong> also clears enrollments &amp; progress.
                        </p>
                      </section>

                      <Separator />

                      {/* Enroll in course */}
                      <section>
                        <h3 className="text-sm font-semibold mb-2">Enroll in Course</h3>
                        <div className="flex gap-2">
                          <Select value={enrollCourse} onValueChange={setEnrollCourse}>
                            <SelectTrigger className="flex-1">
                              <SelectValue placeholder="Select course…" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Select course…</SelectItem>
                              {courses.map((c) => (
                                <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button size="sm" onClick={handleEnroll} disabled={enrollCourse === "none" || enrolling}>
                            {enrolling && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                            Enroll
                          </Button>
                        </div>
                      </section>

                      <Separator />

                      {/* Message history */}
                      <section>
                        <h3 className="text-sm font-semibold mb-2">Last 20 Messages</h3>
                        {messages.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No messages yet.</p>
                        ) : (
                          <div className="space-y-2">
                            {messages.map((msg) => (
                              <div
                                key={msg.id}
                                className={`rounded-lg px-3 py-2 text-xs max-w-[85%] ${
                                  msg.direction === "inbound"
                                    ? "bg-muted self-start"
                                    : "bg-primary/10 ml-auto text-right"
                                }`}
                              >
                                <p className="break-words">{msg.content || <em className="text-muted-foreground">[{msg.message_type}]</em>}</p>
                                <p className="text-muted-foreground mt-0.5">
                                  {msg.direction === "inbound" ? "← learner" : "→ bot"} · {msg.created_at?.slice(0, 16).replace("T", " ")}
                                </p>
                              </div>
                            ))}
                          </div>
                        )}
                      </section>
                    </>
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
};

export default Learners;

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  Panel,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Sidebar from '@/components/dashboard/Sidebar';
import { RequireRole } from '@/components/AuthProvider';
import { apiClient } from '@/services/apiClient';
import type { FSMJson, FSMState, FSMTransition, FSMListItem } from '@/services/apiClient';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Plus, Save, GitBranch, ChevronLeft, ChevronRight, Users } from 'lucide-react';

// ── Node colour map ───────────────────────────────────────────────────────────
const NODE_COLORS: Record<FSMState['type'], string> = {
  start: '#22c55e',   // green
  lesson: '#3b82f6',  // blue
  question: '#f59e0b', // amber
  end: '#ef4444',     // red
};

// ── Convert DB FSMJson ↔ React Flow nodes/edges ───────────────────────────────
function toRFNodes(states: FSMState[]): Node[] {
  return states.map((s, i) => ({
    id: s.id,
    type: 'default',
    position: { x: 150 + (i % 4) * 220, y: 80 + Math.floor(i / 4) * 140 },
    data: { label: s.label, nodeType: s.type, stateData: s.data },
    style: {
      background: NODE_COLORS[s.type],
      color: '#fff',
      borderRadius: 8,
      border: '2px solid transparent',
      width: 160,
      fontSize: 13,
      fontWeight: 600,
    },
  }));
}

function toRFEdges(transitions: FSMTransition[]): Edge[] {
  return transitions.map((t) => ({
    id: t.id,
    source: t.from,
    target: t.to,
    label: t.label ?? t.condition ?? '',
    animated: t.condition === 'timeout',
  }));
}

function toFsmJson(nodes: Node[], edges: Edge[]): FSMJson {
  return {
    states: nodes.map((n) => ({
      id: n.id,
      type: n.data.nodeType as FSMState['type'],
      label: n.data.label as string,
      data: (n.data.stateData as Record<string, unknown>) ?? {},
    })),
    transitions: edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      condition: typeof e.label === 'string' ? (e.label || undefined) : undefined,
      label: typeof e.label === 'string' ? e.label : undefined,
    })),
  };
}

let _nodeCounter = 1;
function newNodeId() { return `node_${Date.now()}_${_nodeCounter++}`; }

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function FSMEditor() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedDefId, setSelectedDefId] = useState<string | null>(null);
  const [newFlowName, setNewFlowName] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // List FSM definitions
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['fsm-list'],
    queryFn: () => apiClient.listFsmDefinitions(),
  });

  // Load selected definition
  const { data: defData, isLoading: defLoading } = useQuery({
    queryKey: ['fsm-def', selectedDefId],
    queryFn: () => apiClient.getFsmDefinition(selectedDefId!),
    enabled: !!selectedDefId,
  });

  // Populate canvas when definition loads
  useEffect(() => {
    if (!defData?.data) return;
    const { fsm_json } = defData.data;
    setNodes(toRFNodes(fsm_json.states ?? []));
    setEdges(toRFEdges(fsm_json.transitions ?? []));
  }, [defData]);

  // Create new flow
  const createMutation = useMutation({
    mutationFn: (name: string) => apiClient.createFsmDefinition({ name }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['fsm-list'] });
      setSelectedDefId(res.data.id);
      setNewFlowName('');
      toast({ title: 'Flow created', description: res.data.name });
    },
    onError: (e: Error) => toast({ title: 'Create failed', description: e.message, variant: 'destructive' }),
  });

  // Save FSM (manual + auto)
  const saveMutation = useMutation({
    mutationFn: (json: FSMJson) => apiClient.updateFsmDefinition(selectedDefId!, { fsmJson: json }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fsm-list'] });
      toast({ title: 'Saved', description: 'Flow saved.' });
    },
    onError: (e: Error) => toast({ title: 'Save failed', description: e.message, variant: 'destructive' }),
  });

  const handleSave = useCallback(() => {
    if (!selectedDefId) return;
    saveMutation.mutate(toFsmJson(nodes, edges));
  }, [selectedDefId, nodes, edges]);

  // Auto-save on canvas changes after 1.5s idle
  useEffect(() => {
    if (!selectedDefId || (nodes.length === 0 && edges.length === 0)) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveMutation.mutate(toFsmJson(nodes, edges));
    }, 1500);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [nodes, edges]);

  const onConnect = useCallback(
    (connection: Connection) => setEdges((eds) => addEdge({ ...connection, id: newNodeId() }, eds)),
    [setEdges]
  );

  const addNode = (type: FSMState['type']) => {
    const id = newNodeId();
    const labels: Record<FSMState['type'], string> = { start: 'Start', lesson: 'Lesson', question: 'Question', end: 'End' };
    setNodes((nds) => [
      ...nds,
      {
        id,
        type: 'default',
        position: { x: 200 + Math.random() * 200, y: 200 + Math.random() * 150 },
        data: { label: labels[type], nodeType: type },
        style: { background: NODE_COLORS[type], color: '#fff', borderRadius: 8, border: '2px solid transparent', width: 160, fontSize: 13, fontWeight: 600 },
      },
    ]);
  };

  const definitions: FSMListItem[] = listData?.data ?? [];

  // Live learner positions — poll every 15s when a definition is selected
  const { data: learnerPositionsData } = useQuery({
    queryKey: ['fsm-learners', selectedDefId],
    queryFn: () => apiClient.getFSMLearnerPositions(selectedDefId!),
    enabled: !!selectedDefId,
    refetchInterval: 15000,
  });

  // Build map: nodeId → { count, learners[] }
  const learnerMap = (learnerPositionsData?.data ?? []).reduce<Record<string, { count: number; learners: { id: string; phone: string; name: string }[] }>>(
    (acc, row) => {
      if (row.state_id) acc[row.state_id] = { count: row.learner_count, learners: row.learners };
      return acc;
    },
    {}
  );

  const totalLiveLearners = (learnerPositionsData?.data ?? []).reduce((s, r) => s + r.learner_count, 0);

  return (
    <RequireRole roles={['admin', 'super_admin']} fallback={
      <div className="flex min-h-screen">
        <Sidebar />
        <main className="flex-1 p-8">
          <Alert><AlertDescription>You need admin access to use the Flow Editor.</AlertDescription></Alert>
        </main>
      </div>
    }>
      <div className="flex min-h-screen">
        <Sidebar />

        {/* ── Flow List Panel ── */}
        <div className={`transition-all duration-200 flex flex-col border-r bg-background ${sidebarOpen ? 'w-64' : 'w-10'} shrink-0`}>
          <div className="flex items-center justify-between px-3 py-2 border-b">
            {sidebarOpen && <span className="text-sm font-semibold flex items-center gap-1"><GitBranch className="h-4 w-4" /> Flows</span>}
            <button onClick={() => setSidebarOpen((o) => !o)} className="ml-auto p-1 rounded hover:bg-muted">
              {sidebarOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          </div>

          {sidebarOpen && (
            <>
              {/* Create new flow */}
              <div className="p-3 border-b space-y-2">
                <Input
                  placeholder="New flow name…"
                  value={newFlowName}
                  onChange={(e) => setNewFlowName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && newFlowName.trim() && createMutation.mutate(newFlowName.trim())}
                  className="text-sm"
                />
                <Button
                  size="sm" className="w-full" disabled={!newFlowName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate(newFlowName.trim())}
                >
                  <Plus className="h-3 w-3 mr-1" /> Create
                </Button>
              </div>

              {/* Flow list */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {listLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
                {definitions.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setSelectedDefId(d.id)}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${selectedDefId === d.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
                  >
                    <div className="font-medium truncate">{d.name}</div>
                    <div className="text-xs opacity-60">v{d.version}</div>
                  </button>
                ))}
                {!listLoading && definitions.length === 0 && (
                  <p className="text-xs text-muted-foreground px-2 py-4 text-center">No flows yet. Create one above.</p>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Canvas ── */}
        <main className="flex-1 flex flex-col overflow-hidden">
            {selectedDefId ? (
              <>
                {/* Toolbar */}
                <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
                  <span className="text-sm font-medium text-muted-foreground">Add node:</span>
                  {(['start', 'lesson', 'question', 'end'] as FSMState['type'][]).map((type) => (
                    <Badge
                      key={type}
                      className="cursor-pointer capitalize select-none hover:opacity-80 transition-opacity"
                      style={{ background: NODE_COLORS[type], color: '#fff', border: 'none' }}
                      onClick={() => addNode(type)}
                    >
                      + {type}
                    </Badge>
                  ))}
                  <div className="ml-auto flex items-center gap-2">
                    {saveMutation.isPending && <span className="text-xs text-muted-foreground">Saving…</span>}
                    <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                      <Save className="h-3 w-3 mr-1" /> Save
                    </Button>
                  </div>
                </div>

                {/* React Flow canvas */}
                {defLoading ? (
                  <div className="flex-1 flex items-center justify-center">
                    <Skeleton className="h-64 w-full mx-8" />
                  </div>
                ) : (
                  <div className="flex-1 relative">
                    <ReactFlow
                      nodes={nodes}
                      edges={edges}
                      onNodesChange={onNodesChange}
                      onEdgesChange={onEdgesChange}
                      onConnect={onConnect}
                      fitView
                    >
                      <Background />
                      <Controls />
                      <MiniMap nodeStrokeWidth={3} zoomable pannable />
                      <Panel position="bottom-right" className="text-xs text-muted-foreground">
                        {nodes.length} nodes · {edges.length} edges
                        {totalLiveLearners > 0 && (
                          <span className="ml-2 text-green-600 font-medium">· {totalLiveLearners} live</span>
                        )}
                      </Panel>
                    </ReactFlow>
                    {/* Live learner badges — absolute positioned over canvas */}
                    {Object.keys(learnerMap).length > 0 && (
                      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 pointer-events-auto">
                        <p className="text-xs font-semibold text-muted-foreground bg-background/80 px-2 py-1 rounded flex items-center gap-1">
                          <Users className="h-3 w-3" /> Live learners by state
                        </p>
                        {Object.entries(learnerMap).map(([stateId, info]) => {
                          const node = nodes.find((n) => n.id === stateId);
                          return (
                            <Popover key={stateId}>
                              <PopoverTrigger asChild>
                                <button className="flex items-center gap-2 bg-background/90 border rounded px-2 py-1 text-xs hover:bg-muted text-left">
                                  <span className="font-medium truncate max-w-[120px]">{node?.data?.label as string ?? stateId}</span>
                                  <Badge variant="secondary" className="bg-green-100 text-green-700 shrink-0">{info.count}</Badge>
                                </button>
                              </PopoverTrigger>
                              <PopoverContent className="w-60 p-2">
                                <p className="text-xs font-semibold mb-2">Learners at &ldquo;{node?.data?.label as string ?? stateId}&rdquo;</p>
                                <ul className="space-y-1">
                                  {info.learners.map((l) => (
                                    <li key={l.id} className="text-xs text-muted-foreground">
                                      {l.name || 'Unknown'} · {l.phone}
                                    </li>
                                  ))}
                                </ul>
                              </PopoverContent>
                            </Popover>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-3">
                <GitBranch className="h-12 w-12 opacity-30" />
                <p className="text-sm">Select a flow from the sidebar, or create a new one.</p>
              </div>
            )}
        </main>
      </div>
    </RequireRole>
  );
}

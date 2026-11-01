import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { Plus, Play, Pause, Settings } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { api } from "@/services/apiClient";
import { fetchAllCourseRecords } from "@/lib/api";

const scheduleFormSchema = z.object({
  courseId: z.string().min(1, "Course ID is required"),
  name: z.string().trim().min(1, "Name is required"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  timezone: z.string().min(1, "Timezone is required"),
  days: z.array(z.number()).min(1, "Select at least one day"),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const ScheduleManager = () => {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5]); // Weekdays by default

  const form = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleFormSchema),
    defaultValues: {
      courseId: "",
      name: "",
      time: "09:00",
      timezone: "Asia/Kolkata",
      days: [1, 2, 3, 4, 5],
    },
  });

  // Fetch schedules
  const { data: schedulesData, isLoading } = useQuery({
    queryKey: ["schedules"],
    queryFn: () => api.getSchedules(),
  });

  const schedules: any[] = Array.isArray(schedulesData) ? schedulesData : (schedulesData as any)?.data || [];

  // Fetch courses for dropdown. Own key: ['courses'] holds the mapped Course[] that
  // Dashboard/Courses render, and this picker caches raw course records (every page).
  const { data: coursesData } = useQuery({
    queryKey: ["courses", "schedule-picker"],
    queryFn: () => fetchAllCourseRecords(),
  });

  const courses = coursesData ?? [];

  // Create schedule mutation
  const createScheduleMutation = useMutation({
    mutationFn: (data: ScheduleFormValues) =>
      // Field names match POST /api/schedules (name and sendTime are what the route reads).
      api.createSchedule({
        courseId: data.courseId,
        name: data.name.trim(),
        sendTime: data.time,
        timezone: data.timezone,
        daysOfWeek: data.days,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      setIsDialogOpen(false);
      form.reset();
      setSelectedDays([1, 2, 3, 4, 5]);
      toast({
        title: "Success",
        description: "Schedule created successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Pause/resume via the dedicated routes (they flip is_active)
  const updateScheduleMutation = useMutation({
    mutationFn: ({ id, pause }: { id: string; pause: boolean }) =>
      pause ? api.pauseSchedule(id) : api.resumeSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["schedules"] });
      toast({
        title: "Success",
        description: "Schedule updated successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Trigger push mutation
  const triggerPushMutation = useMutation({
    mutationFn: (scheduleId: string) => api.triggerPush(scheduleId),
    onSuccess: () => {
      toast({
        title: "Success",
        description: "Push triggered successfully",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (data: ScheduleFormValues) => {
    createScheduleMutation.mutate(data);
  };

  const toggleSchedule = (id: string, currentlyActive: boolean) => {
    updateScheduleMutation.mutate({ id, pause: currentlyActive });
  };

  const triggerManualPush = (scheduleId: string) => {
    triggerPushMutation.mutate(scheduleId);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Course Schedules</CardTitle>
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Schedule
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Schedule</DialogTitle>
                <DialogDescription>
                  Set up a recurring schedule for course delivery
                </DialogDescription>
              </DialogHeader>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="courseId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Course</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="w-full px-3 py-2 border rounded-md"
                          >
                            <option value="">Select a course</option>
                            {courses.map((course) => (
                              <option key={course.id} value={course.id}>
                                {course.title}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Morning lesson" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="time"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Time (HH:MM)</FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="09:00" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="timezone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Timezone</FormLabel>
                        <FormControl>
                          <select
                            {...field}
                            className="w-full px-3 py-2 border rounded-md"
                          >
                            <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                            <option value="America/New_York">America/New_York (EST)</option>
                            <option value="Europe/London">Europe/London (GMT)</option>
                            <option value="Asia/Tokyo">Asia/Tokyo (JST)</option>
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <div>
                    <FormLabel>Days of Week</FormLabel>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {WEEKDAYS.map((day) => (
                        <Button
                          key={day.value}
                          type="button"
                          variant={selectedDays.includes(day.value) ? "default" : "outline"}
                          size="sm"
                          onClick={() => {
                            const newDays = selectedDays.includes(day.value)
                              ? selectedDays.filter((d) => d !== day.value)
                              : [...selectedDays, day.value];
                            setSelectedDays(newDays);
                            form.setValue("days", newDays);
                          }}
                        >
                          {day.label.slice(0, 3)}
                        </Button>
                      ))}
                    </div>
                  </div>

                  <DialogFooter>
                    <Button type="submit" disabled={createScheduleMutation.isPending}>
                      {createScheduleMutation.isPending ? "Creating..." : "Create Schedule"}
                    </Button>
                  </DialogFooter>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p>Loading schedules...</p>
        ) : schedules.length === 0 ? (
          <p className="text-muted-foreground">No schedules configured</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Course</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Days</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule: any) => (
                <TableRow key={schedule.id}>
                  {/* Rows come back snake_case from the schedules table (+ course_title) */}
                  <TableCell>
                    <div>{schedule.course_title || schedule.course_id}</div>
                    {schedule.name && <div className="text-xs text-muted-foreground">{schedule.name}</div>}
                  </TableCell>
                  <TableCell>
                    {String(schedule.send_time ?? "").slice(0, 5)} {schedule.timezone}
                  </TableCell>
                  <TableCell>
                    <Badge variant={schedule.is_active ? "default" : "secondary"}>
                      {schedule.is_active ? "Active" : "Paused"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {Array.isArray(schedule.days_of_week)
                      ? schedule.days_of_week
                          .map((d: number) => WEEKDAYS.find((w) => w.value === Number(d) % 7)?.label.slice(0, 3) ?? d)
                          .join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleSchedule(schedule.id, !!schedule.is_active)}
                        disabled={updateScheduleMutation.isPending}
                        title={schedule.is_active ? "Pause" : "Resume"}
                      >
                        {!schedule.is_active ? (
                          <Play className="h-4 w-4" />
                        ) : (
                          <Pause className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => triggerManualPush(schedule.id)}
                        disabled={triggerPushMutation.isPending}
                      >
                        <Play className="h-4 w-4 mr-1" />
                        Trigger
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
};

export default ScheduleManager;

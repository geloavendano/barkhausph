function timeToMinutes(value: unknown): number {
  const text = String(value ?? "").trim();
  const display = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (display) {
    let hour = Number(display[1]);
    const minute = Number(display[2]);
    const period = display[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }
  const database = text.match(/^(\d{1,2}):(\d{2})/);
  return database ? Number(database[1]) * 60 + Number(database[2]) : -1;
}

function groomingDuration(body: Record<string, any>): number {
  const base: Record<string, number> = { bath_dry: 30, basic: 60, premium: 120, ala_carte: 60 };
  const hasBuffer = Object.keys(body.addons ?? {}).some((key) => key === "demat" || key === "deshed");
  return (base[body.groomService] ?? 60) + (hasBuffer ? 30 : 0);
}

export function inventoryLockKey(branchId: string, body: Record<string, any>): string | null {
  if (body.service === "grooming" && body.groomDate) {
    return `${branchId}:grooming:${body.groomDate}`;
  }
  if (body.service === "studio" && body.studioDate) {
    return `${branchId}:studio:${body.studioDate}`;
  }
  if (body.service === "hotel" && body.hotelCheckin && body.hotelCheckout) {
    // Hotel reservations are less frequent; a branch-wide mutex safely covers
    // overlapping date ranges without needing several independently acquired locks.
    return `${branchId}:hotel`;
  }
  return null;
}

export async function assertHostedInventory(
  supabase: any,
  branchId: string,
  body: Record<string, any>,
): Promise<void> {
  if (body.service === "grooming") {
    if (!body.groomDate || !body.groomSlot) throw new Error("Grooming date and slot are required.");
    const [{ data: groomers, error: groomerError }, { data: hours, error: hoursError }, { data: blocks, error: blockError }] = await Promise.all([
      supabase.from("groomers").select("id").eq("branch_id", branchId).eq("active", true).eq("is_unavailable", false),
      supabase.from("resource_service_hours").select("resource_id,start_time,end_time,last_service_time")
        .eq("branch_id", branchId).eq("resource_type", "groomer").eq("service_date", body.groomDate).eq("active", true),
      supabase.from("blocked_schedules").select("resource_id,start_time,end_time")
        .eq("resource_type", "groomer").eq("active", true).contains("dates", [body.groomDate]),
    ]);
    if (groomerError || hoursError || blockError) throw new Error("Could not validate grooming inventory.");

    const { data: bookingRows, error: bookingError } = await supabase
      .from("grooming_details")
      .select("booking_id,groomer_id,timeslot,groom_service_key,bookings!inner(branch_id,status)")
      .eq("service_date", body.groomDate)
      .eq("bookings.branch_id", branchId)
      .not("bookings.status", "in", "(cancelled,rejected)");
    if (bookingError) throw new Error(`Could not validate grooming bookings: ${bookingError.message}`);

    const bookingIds = (bookingRows ?? []).map((row: any) => row.booking_id).filter(Boolean);
    const durationAddonIds = new Set<string>();
    if (bookingIds.length) {
      const { data: addOns, error } = await supabase.from("booking_addons")
        .select("booking_id,addon_key").in("booking_id", bookingIds).in("addon_key", ["demat", "deshed"]);
      if (error) throw new Error(`Could not validate grooming add-ons: ${error.message}`);
      (addOns ?? []).forEach((row: any) => durationAddonIds.add(row.booking_id));
    }

    const start = timeToMinutes(body.groomSlot);
    const end = start + groomingDuration(body);
    if (start < 0) throw new Error("Invalid grooming slot.");
    const overlaps = (rangeStart: number, rangeEnd: number) => start < rangeEnd && end > rangeStart;
    const durationFor = (row: any) => {
      const base: Record<string, number> = { bath_dry: 30, basic: 60, premium: 120, ala_carte: 60 };
      return (base[row.groom_service_key] ?? 60) + (durationAddonIds.has(row.booking_id) ? 30 : 0);
    };
    const canServe = (groomerId: string) => {
      const window = (hours ?? []).find((row: any) => row.resource_id === groomerId);
      if (!window) return false;
      const windowStart = timeToMinutes(window.start_time);
      const windowEnd = timeToMinutes(window.end_time);
      const lastService = timeToMinutes(window.last_service_time);
      if (start < windowStart || start > lastService || end > windowEnd) return false;
      if ((blocks ?? []).some((row: any) =>
        row.resource_id === groomerId &&
        overlaps(timeToMinutes(row.start_time), timeToMinutes(row.end_time))
      )) return false;
      return !(bookingRows ?? []).some((row: any) => {
        if (row.groomer_id !== groomerId || !row.timeslot) return false;
        const bookedStart = timeToMinutes(row.timeslot);
        return overlaps(bookedStart, bookedStart + durationFor(row));
      });
    };

    const unassigned = (bookingRows ?? []).filter((row: any) => {
      if (row.groomer_id != null || !row.timeslot) return false;
      const bookedStart = timeToMinutes(row.timeslot);
      return overlaps(bookedStart, bookedStart + durationFor(row));
    }).length;
    const pool = groomers ?? [];
    const selectedId = body.preferredStylistId || null;
    const available = selectedId
      ? pool.some((row: any) => row.id === selectedId) && canServe(selectedId) &&
        unassigned <= pool.filter((row: any) => row.id !== selectedId && canServe(row.id)).length
      : pool.filter((row: any) => canServe(row.id)).length > unassigned;
    if (!available) throw new Error("That grooming slot is no longer available.");
    return;
  }

  if (body.service === "hotel") {
    if (!body.hotelCheckin || !body.hotelCheckout || !body.hotelRoomId) {
      throw new Error("Hotel dates and room selection are required.");
    }
    if (body.hotelCheckout <= body.hotelCheckin) throw new Error("Hotel checkout must be after check-in.");
    const { data: room, error: roomError } = await supabase.from("rooms")
      .select("id,room_type,allowed_sizes")
      .eq("id", body.hotelRoomId).eq("branch_id", branchId)
      .eq("active", true).eq("is_locked", false).maybeSingle();
    if (roomError || !room) throw new Error("That room is no longer available.");
    if (body.hotelRoom && body.hotelRoom !== room.room_type) throw new Error("Selected room type does not match.");
    if (body.petSize && (!Array.isArray(room.allowed_sizes) || !room.allowed_sizes.includes(body.petSize))) {
      throw new Error("That room is not available for this pet size.");
    }
    const { data: overlaps, error } = await supabase.from("hotel_details")
      .select("booking_id,bookings!inner(branch_id,status)")
      .eq("room_id", body.hotelRoomId)
      .lt("checkin_date", body.hotelCheckout).gt("checkout_date", body.hotelCheckin)
      .eq("bookings.branch_id", branchId)
      .not("bookings.status", "in", "(cancelled,rejected)").limit(1);
    if (error) throw new Error(`Could not validate hotel inventory: ${error.message}`);
    if (overlaps?.length) throw new Error("That room is no longer available.");
    return;
  }

  if (body.service === "studio") {
    if (!body.studioDate || !body.studioSlot) throw new Error("Studio date and slot are required.");
    const { data: studios, error: studioError } = await supabase.from("studios")
      .select("id").eq("branch_id", branchId).eq("active", true).eq("is_unavailable", false);
    if (studioError || !studios?.length) throw new Error("No studio is available.");
    const [{ data: rows, error }, { data: recurringBlocks }, { data: datedBlocks }] = await Promise.all([
      supabase.from("studio_details")
        .select("studio_id,timeslot,bookings!inner(branch_id,status)")
        .eq("service_date", body.studioDate)
        .eq("bookings.branch_id", branchId)
        .not("bookings.status", "in", "(cancelled,rejected)"),
      supabase.from("studio_blocks")
        .select("studio_id,start_time,end_time,days_of_week").eq("active", true),
      supabase.from("blocked_schedules")
        .select("resource_id,start_time,end_time").eq("resource_type", "studio")
        .eq("active", true).contains("dates", [body.studioDate]),
    ]);
    if (error) throw new Error(`Could not validate studio inventory: ${error.message}`);
    const start = timeToMinutes(body.studioSlot);
    const end = start + 60;
    if (start < 0) throw new Error("Invalid studio slot.");
    const dayOfWeek = new Date(`${body.studioDate}T00:00:00`).getDay();
    const overlaps = (rangeStart: number, rangeEnd: number) => start < rangeEnd && end > rangeStart;
    const occupied = new Set((rows ?? [])
      .filter((row: any) => row.studio_id && overlaps(
        timeToMinutes(row.timeslot),
        timeToMinutes(row.timeslot) + 60,
      ))
      .map((row: any) => row.studio_id));
    const unassigned = (rows ?? []).filter((row: any) =>
      !row.studio_id && overlaps(timeToMinutes(row.timeslot), timeToMinutes(row.timeslot) + 60)
    ).length;
    const availableStudios = (studios ?? []).filter((studio: any) => {
      if (occupied.has(studio.id)) return false;
      if ((recurringBlocks ?? []).some((block: any) =>
        block.studio_id === studio.id &&
        (!block.days_of_week?.length || block.days_of_week.includes(dayOfWeek)) &&
        overlaps(timeToMinutes(block.start_time), timeToMinutes(block.end_time))
      )) return false;
      return !(datedBlocks ?? []).some((block: any) =>
        block.resource_id === studio.id &&
        overlaps(timeToMinutes(block.start_time), timeToMinutes(block.end_time))
      );
    });
    const availableStudio = availableStudios.length > unassigned
      ? availableStudios[unassigned]
      : null;
    if (!availableStudio) {
      throw new Error("That studio slot is no longer available.");
    }
    body._reservedStudioId = availableStudio.id;
  }
}

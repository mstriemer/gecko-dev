/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gc/WeakMap-inl.h"

#include <string.h>

#include "gc/PublicIterators.h"
#include "vm/JSObject.h"

#include "gc/Marking-inl.h"

using namespace js;
using namespace js::gc;

WeakMapBase::WeakMapBase(JSObject* memOf, Zone* zone)
    : memberOf(memOf), zone_(zone), mapColor(CellColor::White) {
  MOZ_ASSERT_IF(memberOf, memberOf->compartment()->zone() == zone);
}

WeakMapBase::~WeakMapBase() {
  MOZ_ASSERT(CurrentThreadIsGCFinalizing() ||
             CurrentThreadCanAccessZone(zone_));
}

void WeakMapBase::unmarkZone(JS::Zone* zone) {
  AutoEnterOOMUnsafeRegion oomUnsafe;
  if (!zone->gcEphemeronEdges().clear()) {
    oomUnsafe.crash("clearing ephemeron edges table");
  }
  MOZ_ASSERT(zone->gcNurseryEphemeronEdges().count() == 0);

  for (WeakMapBase* m : zone->gcWeakMapList()) {
    m->mapColor = CellColor::White;
  }
}

void Zone::traceWeakMaps(JSTracer* trc) {
  MOZ_ASSERT(trc->weakMapAction() != JS::WeakMapTraceAction::Skip);
  for (WeakMapBase* m : gcWeakMapList()) {
    m->trace(trc);
    TraceNullableEdge(trc, &m->memberOf, "memberOf");
  }
}

bool WeakMapBase::addImplicitEdges(Cell* key, Cell* delegate,
                                   TenuredCell* value) {
  if (delegate) {
    return addEphemeronTableEntries(delegate, key, value);
  }

  if (value) {
    return addEphemeronTableEntries(key, value, nullptr);
  }

  return true;
}

bool WeakMapBase::addEphemeronTableEntries(gc::Cell* key, gc::Cell* value1,
                                           gc::Cell* maybeValue2) {
  // Add implicit edges from |key| to |value1| and |maybeValue2| if supplied.
  //
  // Note the key and values do not necessarily correspond to the weak map
  // entry's key and value at this point.

  auto& edgeTable = key->zone()->gcEphemeronEdges(key);
  auto* ptr = edgeTable.getOrAdd(key);
  if (!ptr) {
    return false;
  }

  MarkColor mapColor = AsMarkColor(this->mapColor);
  if (!ptr->value.emplaceBack(mapColor, value1)) {
    return false;
  }

  if (maybeValue2 && !ptr->value.emplaceBack(mapColor, maybeValue2)) {
    return false;
  }

  return true;
}

#if defined(JS_GC_ZEAL) || defined(DEBUG)
bool WeakMapBase::checkMarkingForZone(JS::Zone* zone) {
  // This is called at the end of marking.
  MOZ_ASSERT(zone->isGCMarking());

  bool ok = true;
  for (WeakMapBase* m : zone->gcWeakMapList()) {
    if (IsMarked(m->mapColor) && !m->checkMarking()) {
      ok = false;
    }
  }

  return ok;
}
#endif

bool WeakMapBase::markZoneIteratively(JS::Zone* zone, GCMarker* marker) {
  bool markedAny = false;
  for (WeakMapBase* m : zone->gcWeakMapList()) {
    if (IsMarked(m->mapColor) && m->markEntries(marker)) {
      markedAny = true;
    }
  }
  return markedAny;
}

bool WeakMapBase::findSweepGroupEdgesForZone(JS::Zone* zone) {
  for (WeakMapBase* m : zone->gcWeakMapList()) {
    if (!m->findSweepGroupEdges()) {
      return false;
    }
  }
  return true;
}

void Zone::sweepWeakMaps(JSTracer* trc) {
  for (WeakMapBase* m = gcWeakMapList().getFirst(); m;) {
    WeakMapBase* next = m->getNext();
    if (IsMarked(m->mapColor)) {
      m->traceWeakEdges(trc);
    } else {
      m->clearAndCompact();
      m->removeFrom(gcWeakMapList());
    }
    m = next;
  }

#ifdef DEBUG
  for (WeakMapBase* m : gcWeakMapList()) {
    MOZ_ASSERT(m->isInList() && IsMarked(m->mapColor));
  }
#endif
}

void WeakMapBase::traceAllMappings(WeakMapTracer* tracer) {
  JSRuntime* rt = tracer->runtime;
  for (ZonesIter zone(rt, SkipAtoms); !zone.done(); zone.next()) {
    for (WeakMapBase* m : zone->gcWeakMapList()) {
      // The WeakMapTracer callback is not allowed to GC.
      JS::AutoSuppressGCAnalysis nogc;
      m->traceMappings(tracer);
    }
  }
}

bool WeakMapBase::saveZoneMarkedWeakMaps(JS::Zone* zone,
                                         WeakMapColors& markedWeakMaps) {
  for (WeakMapBase* m : zone->gcWeakMapList()) {
    if (IsMarked(m->mapColor) && !markedWeakMaps.put(m, m->mapColor)) {
      return false;
    }
  }
  return true;
}

void WeakMapBase::restoreMarkedWeakMaps(WeakMapColors& markedWeakMaps) {
  for (WeakMapColors::Range r = markedWeakMaps.all(); !r.empty();
       r.popFront()) {
    WeakMapBase* map = r.front().key();
    MOZ_ASSERT(map->zone()->isGCMarking());
    MOZ_ASSERT(map->mapColor == CellColor::White);
    map->mapColor = r.front().value();
  }
}

ObjectWeakMap::ObjectWeakMap(JSContext* cx) : map(cx, nullptr) {}

JSObject* ObjectWeakMap::lookup(const JSObject* obj) {
  if (ObjectValueWeakMap::Ptr p = map.lookup(const_cast<JSObject*>(obj))) {
    return &p->value().toObject();
  }
  return nullptr;
}

bool ObjectWeakMap::add(JSContext* cx, JSObject* obj, JSObject* target) {
  MOZ_ASSERT(obj && target);

  Value targetVal(ObjectValue(*target));
  if (!map.putNew(obj, targetVal)) {
    ReportOutOfMemory(cx);
    return false;
  }

  return true;
}

void ObjectWeakMap::remove(JSObject* key) {
  MOZ_ASSERT(key);
  map.remove(key);
}

void ObjectWeakMap::clear() { map.clear(); }

void ObjectWeakMap::trace(JSTracer* trc) { map.trace(trc); }

size_t ObjectWeakMap::sizeOfExcludingThis(mozilla::MallocSizeOf mallocSizeOf) {
  return map.shallowSizeOfExcludingThis(mallocSizeOf);
}

#ifdef JSGC_HASH_TABLE_CHECKS
void ObjectWeakMap::checkAfterMovingGC() {
  for (ObjectValueWeakMap::Range r = map.all(); !r.empty(); r.popFront()) {
    CheckGCThingAfterMovingGC(r.front().key().get());
    CheckGCThingAfterMovingGC(&r.front().value().toObject());
  }
}
#endif  // JSGC_HASH_TABLE_CHECKS

import sys
import os

path = 'src/App.tsx'
if not os.path.exists(path):
    print(f"Error: {path} not found")
    sys.exit(1)

with open(path, 'rb') as f:
    data = f.read()

# Target the corrupted bridge
marker_start = b'placeholder={`'
marker_end = b'{(results.length > 0 || manualBills.length > 0 || !isBusy || items.some(it => !it.billId)) && ('

# Find the indices
idx1 = data.find(marker_start)
idx2 = data.find(marker_end)

if idx1 != -1 and idx2 != -1:
    print(f"Found markers at {idx1} and {idx2}")
    
    # Restored block (Step 1 end + Step 2 start)
    restored_text = """คนที่ ${idx + 1}`}
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-violet-400 transition-all shadow-sm"
                  />
                  <button
                    onClick={() => removeMember(member.id)}
                    disabled={members.length <= 1}
                    className="shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500 disabled:opacity-30 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2 pl-9">
                  <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider shrink-0">PromptPay:</label>
                  <input
                    value={member.promptPayId || ''}
                    onChange={(e) => updateMember(member.id, 'promptPayId', e.target.value)}
                    placeholder="เบอร์โทร หรือ เลขบัตร"
                    className="flex-1 bg-transparent border-none p-0 text-[11px] font-mono font-bold text-gray-600 focus:ring-0 placeholder:text-gray-300"
                  />
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={addMember}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-3 text-sm font-semibold text-gray-400 transition hover:border-violet-300 hover:text-violet-600 hover:bg-violet-50/50"
          >
            <Plus className="h-4 w-4" />
            เพิ่มคนหารบิล
          </button>
        </SectionCard>

        {/* ── STEP 2: ใบเสร็จ & รายการ ── */}\n        """
    
    restored_bytes = restored_text.encode('utf-8')
    
    new_data = data[:idx1 + len(marker_start)] + restored_bytes + data[idx2:]
    
    with open(path, 'wb') as f:
        f.write(new_data)
    print('SUCCESS: Repaired corrupted boundary bytes.')
else:
    print(f'ERROR: Could not find markers. idx1={idx1}, idx2={idx2}')

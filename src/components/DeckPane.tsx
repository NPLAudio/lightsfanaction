import { useEffect, useMemo, useRef } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Disclosure } from '@/components/Disclosure'
import { EffectCard, EffectOptions } from '@/components/EffectControls'
import { SliderField, SwitchField } from '@/components/Field'
import { frames } from '@/engine'
import { DEFAULT_DECK, DETAIL_GRID, deckDeviceId, deckLayout, settingsFor, useDecks, type DeckDetail, type DeckReport } from '@/lib/deckState'
import type { Assignment, Device } from '@/lib/types'

const DETAIL_LABEL: Record<DeckDetail, string> = {
  color: 'One color per key',
  smooth: 'Smooth across each key',
  fine: 'Fine detail',
}

/** The deck drawn as it is: every key slot outlined, and the keys that carry a display key filled with the live picture. */
function DeckPreview({ dev, deck, gap, g }: { dev: Device; deck: DeckReport; gap: number; g: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const layout = useMemo(() => deckLayout(deck, { ...DEFAULT_DECK, detail: g === 1 ? 'color' : g === 8 ? 'smooth' : 'fine', gap: gap * 100 }), [deck, gap, g])
  const unitsW = deck.columns + (deck.columns - 1) * gap
  const unitsH = deck.rows + (deck.rows - 1) * gap
  const width = 560
  const key = width / unitsW
  const height = Math.round(unitsH * key)

  useEffect(() => {
    const cv = ref.current!
    const dpr = window.devicePixelRatio || 1
    cv.width = width * dpr
    cv.height = height * dpr
    const ctx = cv.getContext('2d')!
    ctx.scale(dpr, dpr)
    const cell = key / g
    let raf = 0
    const draw = () => {
      ctx.clearRect(0, 0, width, height)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      for (let c = 0; c < deck.columns; c++) {
        for (let r = 0; r < deck.rows; r++) {
          ctx.beginPath()
          ctx.roundRect(c * (1 + gap) * key + 0.5, r * (1 + gap) * key + 0.5, key - 1, key - 1, key * 0.1)
          ctx.stroke()
        }
      }
      const colors = frames.get(dev.id)
      if (colors && colors.length === layout.positions.length) {
        for (let i = 0; i < colors.length; i++) {
          const [x, y] = layout.positions[i]
          const c = colors[i]
          ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
          ctx.fillRect(x * width - cell / 2, y * height - cell / 2, Math.ceil(cell), Math.ceil(cell))
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [dev.id, deck, gap, g, layout, key, width, height])

  return <canvas ref={ref} style={{ width, height }} aria-label="Stream Deck preview" />
}

/**
 * A Stream Deck as an item in the lighting list. Every key carrying a Lighting display key shows its part of the
 * picture, placed by its column and row; keys without one are never touched.
 */
export function DeckPane({ dev, a }: { dev: Device; a: Assignment }) {
  const deck = useDecks((s) => s.decks.find((d) => deckDeviceId(d.id) === dev.id))
  const all = useDecks((s) => s.settings)
  const patch = useDecks((s) => s.patch)
  if (!deck) return null
  const s = settingsFor(all, deck.id)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{dev.name}</h1>
        <p className="text-sm text-muted-foreground">{dev.note}</p>
      </div>

      <Card>
        <CardContent className="grid place-items-center overflow-hidden py-6">
          <DeckPreview dev={dev} deck={deck} gap={s.gap / 100} g={DETAIL_GRID[s.detail]} />
        </CardContent>
      </Card>

      <EffectCard dev={dev} a={a} />
      <EffectOptions dev={dev} a={a} />

      <Disclosure title="Deck options" summary={`${s.fps} a second · ${DETAIL_LABEL[s.detail]} · gap ${s.gap}%${s.ripples ? ' · ripples' : ''}`}>
        <SliderField label="Updates a second" value={s.fps} min={1} max={30} onChange={(v) => patch(deck.id, { fps: v })} />
        <div className="space-y-2">
          <Label>Detail</Label>
          <Select
            value={s.detail}
            onValueChange={(v) => v && patch(deck.id, { detail: v as DeckDetail })}
            items={(Object.keys(DETAIL_LABEL) as DeckDetail[]).map((d) => ({ value: d, label: DETAIL_LABEL[d] }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(DETAIL_LABEL) as DeckDetail[]).map((d) => (
                <SelectItem key={d} value={d}>
                  {DETAIL_LABEL[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            More detail lets an effect flow smoothly across each key, at the cost of more work for the Stream Deck software.
          </p>
        </div>
        <SwitchField
          label="Key-press ripples"
          description="Pressing a display key sends a ring of light across the deck, over the running effect."
          checked={s.ripples}
          onChange={(v) => patch(deck.id, { ripples: v })}
        />
        <SliderField
          label="Gap between keys"
          value={s.gap}
          min={0}
          max={60}
          unit="%"
          onChange={(v) => patch(deck.id, { gap: v })}
        />
        <p className="text-sm text-muted-foreground">
          Match the space between your keys so a pattern lines up across them like one screen.
        </p>
      </Disclosure>
    </div>
  )
}

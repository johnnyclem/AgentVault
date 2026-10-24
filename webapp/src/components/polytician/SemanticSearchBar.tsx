'use client'

import { useState, useCallback, useEffect, useRef } from 'react'

// A Polytician 3.0 search hit: concepts have no name, and score is in [0, 1]
interface SearchResult {
  id: string
  namespace?: string
  score?: number
  tags?: string[]
}

interface SemanticSearchBarProps {
  agentId: string
  onSelect?: (result: SearchResult) => void
  debounceMs?: number
}

export function SemanticSearchBar({
  agentId,
  onSelect,
  debounceMs = 300,
}: SemanticSearchBarProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showResults, setShowResults] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  const search = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setResults([])
      return
    }

    setLoading(true)
    setError(null)

    try {
      const res = await fetch(
        `/api/polytician/${agentId}/search?q=${encodeURIComponent(searchQuery)}&limit=10`,
        {
          headers: {
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN || ''}`,
          },
        }
      )

      if (!res.ok) {
        throw new Error(`Search failed: ${res.status}`)
      }

      const data = await res.json()
      if (data.success) {
        setResults(data.data.results || [])
        setShowResults(true)
      } else {
        setError(data.error?.message || 'Search failed')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim()) {
        search(query)
      } else {
        setResults([])
        setShowResults(false)
      }
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [query, debounceMs, search])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        resultsRef.current &&
        !resultsRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        setShowResults(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = (result: SearchResult) => {
    onSelect?.(result)
    setShowResults(false)
  }

  return (
    <div className="relative w-full max-w-xl">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setShowResults(true)}
          placeholder="Search concepts semantically..."
          className="w-full px-4 py-2 pl-10 border bg-background rounded-lg placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {error && (
        <div className="mt-2 p-2 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">
          {error}
        </div>
      )}

      {showResults && results.length > 0 && (
        <div
          ref={resultsRef}
          className="absolute z-10 w-full mt-1 bg-popover text-popover-foreground border rounded-lg shadow-lg max-h-80 overflow-y-auto"
        >
          {results.map((result) => (
            <button
              key={result.id}
              onClick={() => handleSelect(result)}
              className="w-full px-4 py-3 text-left hover:bg-muted/50 border-b last:border-b-0"
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="font-medium">{result.id}</div>
                  <div className="text-sm text-muted-foreground">{(result.tags ?? []).join(', ')}</div>
                </div>
                {result.score !== undefined && (
                  <div className="flex flex-col items-end">
                    <div className="text-xs text-muted-foreground mb-1">
                      {(result.score * 100).toFixed(0)}% match
                    </div>
                    <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all"
                        style={{ width: `${result.score * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {showResults && query && !loading && results.length === 0 && (
        <div className="absolute z-10 w-full mt-1 p-4 bg-popover border rounded-lg shadow-lg text-center text-sm text-muted-foreground">
          No matching concepts found
        </div>
      )}
    </div>
  )
}

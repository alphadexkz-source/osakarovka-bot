"""
Google Maps scraper для Осакаровки.
Сохраняет в таблицу `addresses` (Supabase) — тот же формат что и import_2gis_daily.js

Установка:
    pip install playwright requests python-dotenv
    playwright install chromium

Запуск:
    python tools/import_gmaps.py
    python tools/import_gmaps.py --category "аптека" --total 20
    python tools/import_gmaps.py --csv  # только CSV без сохранения в БД
"""

import os
import re
import time
import json
import hashlib
import argparse
import logging
from typing import Optional
from dataclasses import dataclass, asdict

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, Page

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "https://jgnfjawqacmaqhgpsbcj.supabase.co")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

CITY = "Осакаровка, Казахстан"

CATEGORIES = [
    "аптека", "больница", "поликлиника", "стоматология", "ветеринар",
    "магазин продукты", "супермаркет", "рынок базар",
    "кафе", "столовая", "ресторан",
    "банк", "банкомат", "казпочта",
    "школа", "детский сад", "колледж",
    "парикмахерская", "салон красоты",
    "автосервис", "шиномонтаж", "автомойка", "азс заправочная",
    "гостиница", "отель",
    "акимат", "полиция", "суд", "прокуратура", "налоговая",
    "магазин одежда", "магазин обувь", "магазин электроника",
    "магазин стройматериалы", "магазин мебель",
    "спортзал фитнес", "библиотека", "мечеть",
]

KZ_TRANSLATIONS = {
    "аптека": "дәріхана",
    "больница": "аурухана",
    "школа": "мектеп",
    "магазин": "дүкен",
    "рынок": "базар",
    "мечеть": "мешіт",
    "почта": "пошта",
    "детский сад": "балабақша",
    "парикмахерская": "шаштараз",
    "банк": "банк",
    "кафе": "дайын тамақ",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)


@dataclass
class Place:
    name: str = ""
    address: str = ""
    phone: str = ""
    website: str = ""
    place_type: str = ""
    reviews_count: Optional[int] = None
    reviews_avg: Optional[float] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    maps_url: str = ""


def _text(page: Page, xpath: str) -> str:
    try:
        loc = page.locator(xpath)
        if loc.count() > 0:
            return loc.first.inner_text(timeout=3000)
    except Exception:
        pass
    return ""


def _coords_from_url(url: str):
    m = re.search(r"@(-?\d+\.\d+),(-?\d+\.\d+)", url)
    if m:
        return float(m.group(1)), float(m.group(2))
    return None, None


def extract_place(page: Page) -> Place:
    p = Place()
    p.maps_url = page.url

    p.name = _text(page, '//div[@class="TIHn2 "]//h1[@class="DUwDvf lfPIob"]')
    if not p.name:
        p.name = _text(page, '//h1')

    p.address = _text(page, '//button[@data-item-id="address"]//div[contains(@class,"fontBodyMedium")]')
    p.website = _text(page, '//a[@data-item-id="authority"]//div[contains(@class,"fontBodyMedium")]')
    p.phone   = _text(page, '//button[contains(@data-item-id,"phone:tel:")]//div[contains(@class,"fontBodyMedium")]')
    p.place_type = _text(page, '//div[@class="LBgpqf"]//button[@class="DkEaL "]')

    raw_cnt = _text(page, '//div[@class="TIHn2 "]//div[@class="fontBodyMedium dmRWX"]//span[@aria-label]')
    if raw_cnt:
        try:
            p.reviews_count = int(re.sub(r"[^\d]", "", raw_cnt))
        except ValueError:
            pass

    raw_avg = _text(page, '//div[@class="TIHn2 "]//span[@aria-hidden]')
    if raw_avg:
        try:
            p.reviews_avg = float(raw_avg.replace(",", ".").strip())
        except ValueError:
            pass

    p.lat, p.lon = _coords_from_url(page.url)

    return p


def scrape(search_for: str, total: int = 20) -> list[Place]:
    results: list[Place] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False)
        page = browser.new_page()
        try:
            page.goto("https://www.google.com/maps", timeout=60000)
            page.wait_for_timeout(1500)

            search_box = page.locator('input[name="q"], #searchboxinput').first
            search_box.fill(search_for)
            page.keyboard.press("Enter")

            page.wait_for_selector('//a[contains(@href, "/maps/place")]', timeout=15000)

            prev = 0
            while True:
                page.mouse.wheel(0, 10000)
                time.sleep(1.5)
                found = page.locator('//a[contains(@href, "/maps/place")]').count()
                log.info(f"  Найдено карточек: {found}")
                if found >= total or found == prev:
                    break
                prev = found

            listings = page.locator('//a[contains(@href, "/maps/place")]').all()[:total]
            log.info(f"  Обрабатываем {len(listings)} мест")

            for listing in listings:
                try:
                    listing.click()
                    page.wait_for_selector('//h1', timeout=10000)
                    time.sleep(1.5)
                    place = extract_place(page)
                    if place.name:
                        results.append(place)
                        log.info(f"  + {place.name}")
                except Exception as e:
                    log.warning(f"  Пропуск: {e}")

        finally:
            browser.close()

    return results


def build_keywords(name: str, category: str) -> list[str]:
    words = set()
    for text in [name.lower(), category.lower()]:
        words.add(text)
        for w in re.split(r"\s+", text):
            if len(w) > 2:
                words.add(w)
    for ru, kz in KZ_TRANSLATIONS.items():
        if ru in name.lower() or ru in category.lower():
            words.add(kz)
    words.discard("")
    return list(words)[:20]


def to_pg_array(lst: list[str]) -> str:
    escaped = ['"' + s.replace('"', '\\"') + '"' for s in lst]
    return "{" + ",".join(escaped) + "}"


def place_to_row(place: Place, category: str) -> dict:
    uid = hashlib.md5((place.name + place.address).encode()).hexdigest()[:16]
    kw = build_keywords(place.name, category)
    return {
        "name":        place.name,
        "category":    place.place_type or category,
        "address":     place.address or f"п. Осакаровка",
        "lat":         place.lat,
        "lon":         place.lon,
        "keywords":    to_pg_array(kw),
        "source":      "gmaps",
        "external_id": f"gmaps_{uid}",
        "is_active":   True,
    }


def save_to_supabase(rows: list[dict]) -> bool:
    import urllib.request
    body = json.dumps(rows).encode()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/addresses?on_conflict=external_id",
        data=body,
        headers={
            "Content-Type":  "application/json",
            "apikey":        SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Prefer":        "resolution=merge-duplicates",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            log.info(f"  Supabase: {resp.status}")
            return True
    except Exception as e:
        log.error(f"  Supabase error: {e}")
        return False


def save_to_csv(places: list[Place], filename: str = "gmaps_output.csv"):
    import csv
    if not places:
        return
    with open(filename, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=asdict(places[0]).keys())
        w.writeheader()
        w.writerows([asdict(p) for p in places])
    log.info(f"  CSV: {filename} ({len(places)} строк)")


def main():
    parser = argparse.ArgumentParser(description="Google Maps scraper → Supabase addresses")
    parser.add_argument("--category", "-c", default=None, help="Категория для поиска (одна)")
    parser.add_argument("--total", "-t", type=int, default=20, help="Кол-во результатов")
    parser.add_argument("--csv", action="store_true", help="Только CSV, без сохранения в БД")
    parser.add_argument("--all", action="store_true", help="Все категории подряд")
    args = parser.parse_args()

    cats = CATEGORIES if args.all else ([args.category] if args.category else [CATEGORIES[0]])

    for cat in cats:
        query = f"{cat} {CITY}"
        log.info(f"\n=== {query} ===")

        places = scrape(query, total=args.total)
        log.info(f"Итого: {len(places)} мест")

        if args.csv:
            save_to_csv(places, f"gmaps_{cat.replace(' ', '_')}.csv")
        else:
            if not SUPABASE_KEY:
                log.error("SUPABASE_SERVICE_KEY не задан в .env — сохранение невозможно")
                save_to_csv(places, f"gmaps_{cat.replace(' ', '_')}.csv")
            else:
                rows = [place_to_row(p, cat) for p in places]
                ok = save_to_supabase(rows)
                if ok:
                    log.info(f"  ✅ Сохранено {len(rows)} в addresses")
                else:
                    save_to_csv(places, f"gmaps_{cat.replace(' ', '_')}.csv")


if __name__ == "__main__":
    main()

"""
Yandex Cloud Function: osakarovka-search-agent
Ищет организации, улицы и объекты в заданном населённом пункте
через Yandex Geocoder + Yandex Search Maps API.

Точка входа: handler(event, context)
"""

import json
import os
import requests

# API-ключ передаётся через переменную окружения
YANDEX_API_KEY = os.environ.get('API_KEY', '')

# Fallback bbox для Осакаровки — используется если геокодер не сработал
FALLBACK_BBOX = {
    'center_lon': 72.5681,
    'center_lat': 50.5619,
    'span_lon':   0.065,
    'span_lat':   0.060,
}

CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
}


def get_bbox(location: str) -> dict:
    """
    Определяет центр и span для локации через Yandex Geocoder.
    Возвращает словарь с center_lon, center_lat, span_lon, span_lat.
    """
    try:
        resp = requests.get(
            'https://geocode-maps.yandex.ru/1.x/',
            params={
                'apikey':  YANDEX_API_KEY,
                'geocode': f'{location}, Казахстан',
                'format':  'json',
                'results': 1,
            },
            timeout=5,
        )
        resp.raise_for_status()
        data = resp.json()

        members = data['response']['GeoObjectCollection']['featureMember']
        if not members:
            print(f'[geocoder] локация "{location}" не найдена, fallback')
            return FALLBACK_BBOX

        obj      = members[0]['GeoObject']
        envelope = obj['boundedBy']['Envelope']

        lower = envelope['lowerCorner'].split()  # 'lon lat'
        upper = envelope['upperCorner'].split()

        lon_min, lat_min = float(lower[0]), float(lower[1])
        lon_max, lat_max = float(upper[0]), float(upper[1])

        return {
            'center_lon': (lon_min + lon_max) / 2,
            'center_lat': (lat_min + lat_max) / 2,
            'span_lon':   lon_max - lon_min,
            'span_lat':   lat_max - lat_min,
        }

    except Exception as e:
        print(f'[geocoder] ошибка: {e}, fallback bbox')
        return FALLBACK_BBOX


def search_objects(bbox: dict, query: str, max_results: int) -> list:
    """
    Ищет объекты через Yandex Search Maps API (biz = организации).
    Возвращает список словарей: name, address, lat, lon, type.
    """
    # Пустой запрос — ищем широко по типу "организация"
    text = query.strip() if query.strip() else 'организация кафе магазин'

    ll  = f"{bbox['center_lon']},{bbox['center_lat']}"
    spn = f"{bbox['span_lon']},{bbox['span_lat']}"

    results = []
    try:
        resp = requests.get(
            'https://search-maps.yandex.ru/v1/',
            params={
                'apikey':  YANDEX_API_KEY,
                'text':    text,
                'lang':    'ru_KZ',
                'll':      ll,
                'spn':     spn,
                'results': min(max_results, 100),  # не больше 100 — лимит бесплатного API
                'type':    'biz',
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

        for feature in data.get('features', []):
            props = feature.get('properties', {})
            geom  = feature.get('geometry', {})
            coords = geom.get('coordinates', [])

            # Категория из CompanyMetaData
            meta       = props.get('CompanyMetaData', {})
            categories = meta.get('Categories', [])
            category   = categories[0].get('name', '') if categories else ''

            results.append({
                'name':    props.get('name', ''),
                'address': props.get('description', ''),
                'lat':     coords[1] if len(coords) > 1 else None,
                'lon':     coords[0] if coords else None,
                'type':    category,
            })

    except Exception as e:
        print(f'[search] ошибка: {e}')

    return results


def handler(event, context):
    """
    Точка входа Yandex Cloud Functions.

    Входящий JSON:
      location    — населённый пункт (default: "Осакаровка")
      query       — что искать (default: "" — всё подряд)
      max_results — макс. кол-во результатов 1-100 (default: 50)

    Ответ:
      { location, query, bbox, total, results: [...] }
    """

    # CORS preflight
    if event.get('httpMethod') == 'OPTIONS':
        return {'statusCode': 200, 'headers': CORS_HEADERS, 'body': ''}

    # Парсим тело
    try:
        raw_body = event.get('body', '{}') or '{}'
        body = json.loads(raw_body) if isinstance(raw_body, str) else raw_body
    except Exception:
        return _error(400, 'Невалидный JSON в теле запроса')

    if not YANDEX_API_KEY:
        return _error(500, 'Переменная окружения API_KEY не задана')

    location    = str(body.get('location', 'Осакаровка'))
    query       = str(body.get('query', ''))
    max_results = max(1, min(int(body.get('max_results', 50)), 100))

    # Геокодируем локацию → bbox
    bbox = get_bbox(location)

    # Ищем объекты
    objects = search_objects(bbox, query, max_results)

    return {
        'statusCode': 200,
        'headers':    CORS_HEADERS,
        'body': json.dumps({
            'location':    location,
            'query':       query,
            'bbox':        bbox,
            'total':       len(objects),
            'results':     objects,
        }, ensure_ascii=False),
    }


def _error(code: int, message: str) -> dict:
    return {
        'statusCode': code,
        'headers':    CORS_HEADERS,
        'body':       json.dumps({'error': message}, ensure_ascii=False),
    }

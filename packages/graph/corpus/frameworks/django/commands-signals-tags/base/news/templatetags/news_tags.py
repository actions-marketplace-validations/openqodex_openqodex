from django import template
from markdown_lib import Library

register = template.Library()
fake = Library()


@register.simple_tag
def headline(story):
    return story.title


@register.filter(name="shout")
def shout(value):
    return value.upper()


@register.inclusion_tag("news/card.html")
def card(story):
    return {"story": story}


@fake.simple_tag
def not_a_tag():
    return None

from app import auth, models


def _create_user(
    db_session, username: str, password: str = "secret123", is_manager: bool = False
) -> models.User:
    user = models.User(
        username=username,
        hashed_password=auth.get_password_hash(password),
        is_manager=is_manager,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _auth_headers(user: models.User) -> dict[str, str]:
    token = auth.create_access_token({"sub": user.username})
    return {"Authorization": f"Bearer {token}"}


def _create_order_for_user(db_session, user: models.User) -> models.Order:
    product = (
        db_session.query(models.Product)
        .filter(models.Product.name == "Espresso")
        .first()
    )
    if not product:
        product = models.Product(name="Espresso", price=3.5, stock=20)
        db_session.add(product)
        db_session.commit()
        db_session.refresh(product)

    order = models.Order(user_id=user.id, status="pending")
    db_session.add(order)
    db_session.commit()
    db_session.refresh(order)

    item = models.OrderItem(order_id=order.id, product_id=product.id, quantity=2)
    db_session.add(item)
    db_session.commit()
    db_session.refresh(order)
    return order


def test_get_order_owner_allowed(client, db_session):
    owner = _create_user(db_session, "alice_staff", is_manager=False)
    order = _create_order_for_user(db_session, owner)

    response = client.get(f"/orders/{order.id}", headers=_auth_headers(owner))
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == order.id
    assert body["user_id"] == owner.id
    assert len(body["items"]) == 1
    assert body["items"][0]["quantity"] == 2


def test_get_order_manager_allowed_for_other_users_order(client, db_session):
    owner = _create_user(db_session, "alice_staff", is_manager=False)
    manager = _create_user(db_session, "carol_manager", is_manager=True)
    order = _create_order_for_user(db_session, owner)

    response = client.get(f"/orders/{order.id}", headers=_auth_headers(manager))
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == order.id
    assert body["user_id"] == owner.id


def test_get_order_non_owner_staff_forbidden(client, db_session):
    owner = _create_user(db_session, "alice_staff", is_manager=False)
    other_staff = _create_user(db_session, "bob_staff", is_manager=False)
    order = _create_order_for_user(db_session, owner)

    response = client.get(f"/orders/{order.id}", headers=_auth_headers(other_staff))
    assert response.status_code == 403
    assert response.json() == {"detail": "Not authorized to access this order"}


def test_get_order_not_found_returns_404_before_auth_guard(client, db_session):
    staff = _create_user(db_session, "bob_staff", is_manager=False)
    manager = _create_user(db_session, "carol_manager", is_manager=True)

    staff_resp = client.get("/orders/99999", headers=_auth_headers(staff))
    assert staff_resp.status_code == 404
    assert staff_resp.json() == {"detail": "Order not found"}

    manager_resp = client.get("/orders/99999", headers=_auth_headers(manager))
    assert manager_resp.status_code == 404
    assert manager_resp.json() == {"detail": "Order not found"}


def test_get_order_unauthenticated_returns_401(client, db_session):
    owner = _create_user(db_session, "alice_staff", is_manager=False)
    order = _create_order_for_user(db_session, owner)

    response = client.get(f"/orders/{order.id}")
    assert response.status_code == 401
